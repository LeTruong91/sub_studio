
import numpy as np
from PIL import Image, ImageDraw


def load_hand_png(path, tip_x, tip_y, target_width=None):
    """Load ảnh PNG bàn tay thật (nền trong suốt) để dùng làm con trỏ vẽ.

    path         : đường dẫn file .png (bắt buộc có kênh alpha, nền trong suốt)
    tip_x, tip_y : toạ độ pixel của ĐẦU NGÒI BÚT trong ảnh gốc (dùng script
                   find_tip.py để xác định 2 số này)
    target_width : nếu muốn resize ảnh về 1 độ rộng khác (giữ tỉ lệ), để None
                   nếu muốn giữ nguyên kích thước gốc

    Trả về: (mảng numpy RGBA, (tip_x, tip_y) đã quy đổi theo tỉ lệ resize)
    """
    img = Image.open(path).convert("RGBA")

    if target_width is not None and target_width != img.width:
        scale = target_width / img.width
        new_size = (int(img.width * scale), int(img.height * scale))
        img = img.resize(new_size, Image.LANCZOS)
        tip_x = int(tip_x * scale)
        tip_y = int(tip_y * scale)

    return np.array(img), (tip_x, tip_y)


def overlay_rgba(base_bgr, overlay_rgba, x, y):
    """Dán overlay (RGBA, numpy) lên base_bgr (BGR, numpy) tại toạ độ (x, y)
    là góc trên-trái của overlay. Cắt phần tràn ra ngoài khung hình.
    """
    oh, ow = overlay_rgba.shape[:2]
    bh, bw = base_bgr.shape[:2]

    x0, y0 = max(x, 0), max(y, 0)
    x1, y1 = min(x + ow, bw), min(y + oh, bh)
    if x0 >= x1 or y0 >= y1:
        return base_bgr

    ox0, oy0 = x0 - x, y0 - y
    ox1, oy1 = ox0 + (x1 - x0), oy0 + (y1 - y0)

    roi = base_bgr[y0:y1, x0:x1]
    ov = overlay_rgba[oy0:oy1, ox0:ox1]
    alpha = ov[:, :, 3:4].astype(np.float32) / 255.0
    ov_bgr = ov[:, :, :3][:, :, ::-1].astype(np.float32)  # RGB -> BGR
    roi[:] = (ov_bgr * alpha + roi.astype(np.float32) * (1 - alpha)).astype(np.uint8)
    return base_bgr