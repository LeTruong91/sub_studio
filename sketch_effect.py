import shutil
import subprocess
import threading
import cv2
import numpy as np
from hand_utils import load_hand_png, overlay_rgba
from render_option import get_render_option
import json

from subprocess_utils import popen_hidden
FPS = 30
POINTS_PER_FRAME = 55     # tốc độ vẽ mặc định (dùng khi KHÔNG truyền duration_seconds)
HOLD_SECONDS = 1.2        # giữ hình vài giây sau khi vẽ xong
BRUSH_RADIUS = 3          # bán kính nét vẽ tạm thời trong lúc 1 cụm đang được vẽ dở

# Tham số encode ffmpeg mặc định (dùng khi không truyền render_option_id)
FFMPEG_CRF = 18            # thấp hơn = nét/nặng hơn, 18 gần như lossless mắt thường
FFMPEG_PRESET = "veryfast"  # tốc độ encode: ultrafast..veryslow (nhanh hơn = file hơi nặng hơn)
# ==================================================
# TRACKING PROCESS ĐANG CHẠY (để hỗ trợ Stop)
# ==================================================
_active_processes = {}          # key -> subprocess.Popen
_active_lock = threading.Lock()
_stop_all_flag = False          # bật True khi người dùng bấm "Dừng tất cả"
def is_stopping():
    return _stop_all_flag
def _run(cmd, track_key=None):
    """Chạy ffmpeg, có track process để có thể stop() giữa chừng."""
    global _stop_all_flag

    if _stop_all_flag:
        raise FFmpegError("Đã bị dừng trước khi bắt đầu.")

    process = popen_hidden(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    if track_key:
        with _active_lock:
            _active_processes[track_key] = process

    stdout, stderr = process.communicate()

    if track_key:
        with _active_lock:
            _active_processes.pop(track_key, None)

    if process.returncode != 0:
        # nếu bị terminate() chủ động, coi đó là "đã dừng" chứ không phải lỗi thật
        stderr_text = stderr.decode("utf-8", errors="ignore")
        raise FFmpegError(stderr_text)

    return process
def imread_unicode(path):
    stream = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(stream, cv2.IMREAD_UNCHANGED)
    return img
def thin_to_skeleton(binary_mask_01):
    """Khung xương 1px (uint8 0/255). Ưu tiên cv2.ximgproc, fallback scikit-image."""
    if hasattr(cv2, "ximgproc"):
        return cv2.ximgproc.thinning((binary_mask_01 * 255).astype(np.uint8))
    from skimage.morphology import skeletonize
    skel = skeletonize(binary_mask_01.astype(bool))
    return (skel * 255).astype(np.uint8)


def order_component_points(points):
    n = len(points)
    if n <= 2:
        return points.copy()

    # tra cứu nhanh: toạ độ (x, y) -> chỉ số điểm
    coord_to_idx = {(int(x), int(y)): i for i, (x, y) in enumerate(points)}
    visited = np.zeros(n, dtype=bool)

    NEI8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

    kdtree = None          # chỉ build khi thực sự cần "nhảy nhánh" (lazy, đỡ tốn thời gian)
    kdtree_remaining = None  # ánh xạ ngược: chỉ số trong cây -> chỉ số điểm gốc

    def nearest_unvisited(cur_xy):
        nonlocal kdtree, kdtree_remaining
        from scipy.spatial import cKDTree
        if kdtree is None:
            kdtree_remaining = np.where(~visited)[0]
            kdtree = cKDTree(points[kdtree_remaining])
        dist, j = kdtree.query(cur_xy)
        return int(kdtree_remaining[j])

    start_idx = np.lexsort((points[:, 0], points[:, 1]))[0]
    order = [start_idx]
    visited[start_idx] = True
    current_idx = start_idx

    for _ in range(n - 1):
        cx, cy = points[current_idx]
        nxt = None
        # thử đi tới 1 lân cận 8-hướng CHƯA THĂM (O(1), trường hợp phổ biến)
        for dx, dy in NEI8:
            cand = coord_to_idx.get((int(cx) + dx, int(cy) + dy))
            if cand is not None and not visited[cand]:
                nxt = cand
                break
        if nxt is None:
            # ngõ cụt / đứt nhánh -> nhảy sang điểm chưa thăm gần nhất (hiếm khi xảy ra)
            kdtree = None  # ép build lại tree với đúng tập điểm còn lại
            nxt = nearest_unvisited(np.array([cx, cy], dtype=float))
        visited[nxt] = True
        order.append(nxt)
        current_idx = nxt

    return points[order]


def build_components(core_mask):
    core_u8 = (core_mask > 0).astype(np.uint8)
    skeleton = thin_to_skeleton(core_mask)

    n_comp, labels, stats, centroids = cv2.connectedComponentsWithStats(core_u8, connectivity=8)
    comp_ids = sorted(range(1, n_comp), key=lambda i: (centroids[i][1], centroids[i][0]))

    components = []
    for cid in comp_ids:
        x, y, w, h = stats[cid, cv2.CC_STAT_LEFT], stats[cid, cv2.CC_STAT_TOP], \
            stats[cid, cv2.CC_STAT_WIDTH], stats[cid, cv2.CC_STAT_HEIGHT]

        # chỉ so sánh/trích trong vùng bbox nhỏ, KHÔNG đụng tới cả ảnh
        labels_roi = labels[y:y + h, x:x + w]
        skeleton_roi = skeleton[y:y + h, x:x + w]
        comp_mask = (labels_roi == cid)   # mask CỤC BỘ, kích thước w x h

        ys_s, xs_s = np.where(comp_mask & (skeleton_roi > 0))
        if len(xs_s) >= 2:
            # cộng lại offset (x, y) của bbox để có toạ độ TUYỆT ĐỐI trên ảnh gốc
            pts = np.stack([xs_s + x, ys_s + y], axis=1)
            ordered_pts = order_component_points(pts)
        else:
            ys_a, xs_a = np.where(comp_mask)
            ordered_pts = np.array([[int(xs_a.mean()) + x, int(ys_a.mean()) + y]])
        components.append(((x, y, w, h), comp_mask, ordered_pts))

    return components

def _scale_pad_filter(src_w, src_h, dst_w, dst_h):
    """Filter ffmpeg: co ảnh vừa khung dst_w x dst_h (giữ nguyên tỉ lệ gốc,
    KHÔNG kéo méo), rồi pad thêm viền trắng cho đủ kích thước đích.
    Trả về None nếu kích thước đích trùng kích thước nguồn (không cần scale).
    """
    if (src_w, src_h) == (dst_w, dst_h):
        return None
    return (
        f"scale={dst_w}:{dst_h}:force_original_aspect_ratio=decrease,"
        f"pad={dst_w}:{dst_h}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1"
    )
def _open_ffmpeg_writer(ffmpeg,input_image, out_video, width, height, fps, render_option_id="0", dst_w =1920,dst_h=1080):
    render_opt = get_render_option(render_option_id)
    cmd = [
        str(ffmpeg),
        "-y",                       # ghi đè output nếu đã tồn tại
        "-loglevel", "error",
        "-f", "rawvideo",
        "-vcodec", "rawvideo",
        "-pix_fmt", "bgr24",        # khớp với thứ tự kênh màu của OpenCV (BGR)
        "-s", f"{width}x{height}",
        "-r", str(fps),
        "-i", "-",                  # đọc frame thô từ stdin
        "-an",                      # không audio
    ]
    vf = _scale_pad_filter(width, height, dst_w, dst_h)
    if vf:
        cmd += ["-vf", vf]
    encoder = render_opt["encoder"]
    cmd += ["-vcodec", encoder, "-preset", render_opt["preset"]]
    if encoder == "h264_nvenc":
        # nvenc: dùng chế độ VBR + cq (constant-quality), không set -b:v cố định
        cmd += ["-rc:v", "vbr", "-cq:v", render_opt["cq"], "-b:v", "0"]
    else:
        cmd += ["-crf", render_opt["crf"]]

    cmd += [
        "-pix_fmt", "yuv420p",      # tương thích trình phát rộng rãi (QuickTime, web...)
        "-movflags", "+faststart",
        out_video,
    ]
    #return _run(cmd, track_key=input_image)
    return popen_hidden(cmd, stdin=subprocess.PIPE)


def build_sketch_video(__windown,option,input_path,width,height, ffmpeg, input_image, out_video, hand_png_path=None, tip=None, hand_width=140,
                        duration_seconds=None, hold_seconds=HOLD_SECONDS, ink_threshold=250):
    # src = cv2.imread(input_image)
    src = imread_unicode(input_image)
    if src is None:
        raise FileNotFoundError(input_image)
    H, W = src.shape[:2]

    # Pad về kích thước CHẴN: libx264 + yuv420p cũng yêu cầu W/H chẵn
    # (giống mp4v trước đây), nên vẫn giữ bước pad này để không bị ffmpeg
    # từ chối hoặc tự động crop kích thước.
    pad_bottom = H % 2
    pad_right = W % 2
    if pad_bottom or pad_right:
        src = cv2.copyMakeBorder(src, 0, pad_bottom, 0, pad_right,
                                  cv2.BORDER_CONSTANT, value=(255, 255, 255))
        H, W = src.shape[:2]

    gray = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY)
    _, core_binary = cv2.threshold(gray, ink_threshold, 1, cv2.THRESH_BINARY_INV)
    core_binary = core_binary.astype(bool)
    __windown.evaluate_js(
            f'updateMediaStatus({json.dumps(input_path)}, "Đang tính đường đi của bút...", "processing");'
        )
    # print("Đang tách cụm nét & tính đường đi bút...")
    components = build_components(core_binary.astype(np.uint8))

    comp_ranges = []   # (bbox, mask_cục_bộ, start_idx, end_idx)
    all_points = []
    counter = 0
    for bbox, mask, pts in components:
        start = counter
        all_points.append(pts)
        counter += len(pts)
        comp_ranges.append((bbox, mask, start, counter))
    path = np.concatenate(all_points, axis=0) if all_points else np.empty((0, 2), dtype=int)
    total_points = len(path)

    if duration_seconds is not None:
        draw_frames = max(1, int(round(duration_seconds * FPS)))
        points_per_frame = max(1, int(np.ceil(total_points / draw_frames))) if total_points else 1
    else:
        points_per_frame = POINTS_PER_FRAME
        draw_frames = max(1, total_points // points_per_frame + 1)

    hold_frames = int(FPS * hold_seconds)
    total_frames = draw_frames + hold_frames
    status_text = f"Thời lượng vẽ: {draw_frames / FPS:.2f}s"
    __windown.evaluate_js(
        f'updateMediaStatus({json.dumps(input_path)}, {json.dumps(status_text)}, "processing")'
    )

    if hand_png_path is not None:
        if tip is None:
            raise ValueError("Cần truyền toạ độ đầu ngòi bút --tip X Y khi dùng --hand (xem find_tip.py)")
        hand_png, (tip_x, tip_y) = load_hand_png(hand_png_path, tip[0], tip[1], target_width=hand_width)
    else:
        raise ValueError(
            "Chưa truyền --hand: bản vá này bỏ hàm make_hand_png() vì nó không tồn tại "
            "trong bản gốc (sẽ gây NameError). Hãy truyền --hand <file.png> --tip X Y."
        )

    # render_opt = get_render_option(option)
    # print(f"Render: {render_opt['name']} ({render_opt['encoder']}) -> {W}x{H}")

    proc = _open_ffmpeg_writer(ffmpeg, input_image,out_video, W, H, FPS, render_option_id=option, dst_w=width,dst_h=height)

    committed = np.zeros((H, W), dtype=bool)   # các cụm đã CHỐT -> khớp 100% ảnh gốc
    comp_idx = 0

    try:
        for f in range(total_frames):
            if f < draw_frames:
                n_points = min(total_points, (f + 1) * points_per_frame)

                # cụm nào đã vẽ xong hẳn -> CHỐT NGAY (đã kiểm chứng: khớp 100% ảnh gốc)
                # Ghi bằng slice theo bbox (nhanh) thay vì boolean OR trên cả ảnh.
                while comp_idx < len(comp_ranges) and n_points >= comp_ranges[comp_idx][3]:
                    (cx0, cy0, cw, ch), mask_c = comp_ranges[comp_idx][0], comp_ranges[comp_idx][1]
                    committed[cy0:cy0 + ch, cx0:cx0 + cw] |= mask_c
                    comp_idx += 1

                visible_ink = committed.copy()

                if comp_idx < len(comp_ranges):
                    (cx0, cy0, cw, ch), mask_c, start_c, end_c = comp_ranges[comp_idx]
                    local_n = n_points - start_c
                    if local_n > 0:
                        partial = np.zeros((H, W), dtype=np.uint8)
                        for (x, y) in path[start_c:start_c + local_n]:
                            cv2.circle(partial, (int(x), int(y)), BRUSH_RADIUS, 1, -1)
                        partial = cv2.dilate(partial, np.ones((5, 5), np.uint8))
                        # mask_c chỉ khác 0 trong đúng vùng bbox của cụm này, nên chỉ cần
                        # AND trong vùng bbox đó là đủ, không cần đụng tới cả ảnh.
                        region = partial[cy0:cy0 + ch, cx0:cx0 + cw]
                        visible_ink[cy0:cy0 + ch, cx0:cx0 + cw] |= (region > 0) & mask_c

                frame = np.full((H, W, 3), 255, dtype=np.uint8)
                frame[visible_ink] = src[visible_ink]
            else:
                # đã vẽ xong hết -> dùng THẲNG ảnh gốc, không tái dựng từ mask nữa.
                frame = src.copy()
                n_points = total_points

            if f < draw_frames and n_points > 0:
                cx, cy = path[n_points - 1]
                overlay_rgba(frame, hand_png, int(cx) - tip_x, int(cy) - tip_y)

            # đẩy frame thô (bgr24, đúng thứ tự kênh OpenCV) qua stdin cho ffmpeg encode
            proc.stdin.write(frame.tobytes())
    finally:
        proc.stdin.close()
        ret = proc.wait()
        if ret != 0:
            raise RuntimeError(f"ffmpeg thoát với mã lỗi {ret} (thử chạy tay lệnh ffmpeg để xem log chi tiết).")

    # print(f"Đã ghi {total_frames} khung hình vào {output_path} (encode bằng ffmpeg/libx264)")


