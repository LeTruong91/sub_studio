"""
find_tip.py
Giúp bạn tìm toạ độ (x, y) của đầu ngòi bút trong ảnh PNG bàn tay thật, để
truyền vào load_hand_png(path, tip_x, tip_y).

Cách dùng:
    python3 find_tip.py hand.png
Script sẽ vẽ một LƯỚI TOẠ ĐỘ đè lên ảnh (mỗi 50px một đường + số), xuất ra
file hand_grid_preview.png. Bạn mở file này lên, nhìn đầu ngòi bút rơi vào
khoảng toạ độ nào rồi tinh chỉnh lại bằng ví dụ dưới đây.

Sau khi có toạ độ ước lượng, chạy tiếp để xem "dấu chấm đỏ" có đúng ngay
đầu ngòi bút không, chỉnh dần cho khớp:
    python3 find_tip.py hand.png --check 45 30
"""
import sys
import numpy as np
from PIL import Image, ImageDraw


def make_grid_preview(path, step=50):
    img = Image.open(path).convert("RGBA")
    out = img.copy()
    d = ImageDraw.Draw(out)
    W, H = img.size
    for x in range(0, W, step):
        d.line([(x, 0), (x, H)], fill=(255, 0, 0, 180), width=1)
        d.text((x + 2, 2), str(x), fill=(255, 0, 0, 255))
    for y in range(0, H, step):
        d.line([(0, y), (W, y)], fill=(0, 120, 255, 180), width=1)
        d.text((2, y + 2), str(y), fill=(0, 120, 255, 255))
    out_path = "hand_grid_preview.png"
    out.save(out_path)
    print(f"Đã lưu {out_path} ({W}x{H}px) — mở lên xem lưới toạ độ đỏ/xanh để ước lượng đầu ngòi bút.")


def make_check_preview(path, tip_x, tip_y):
    img = Image.open(path).convert("RGBA")
    out = img.copy()
    d = ImageDraw.Draw(out)
    r = 6
    d.ellipse((tip_x - r, tip_y - r, tip_x + r, tip_y + r), outline=(255, 0, 0, 255), width=3)
    d.line((tip_x - 15, tip_y, tip_x + 15, tip_y), fill=(255, 0, 0, 255), width=1)
    d.line((tip_x, tip_y - 15, tip_x, tip_y + 15), fill=(255, 0, 0, 255), width=1)
    out_path = "hand_tip_check.png"
    out.save(out_path)
    print(f"Đã lưu {out_path} — kiểm tra vòng tròn đỏ có nằm đúng đầu ngòi bút không.")
    print(f"Nếu đúng rồi, dùng tip_x={tip_x}, tip_y={tip_y} khi gọi load_hand_png().")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Dùng: python3 find_tip.py <hand.png> [--check X Y]")
        sys.exit(1)

    path = sys.argv[1]
    if len(sys.argv) >= 5 and sys.argv[2] == "--check":
        make_check_preview(path, int(sys.argv[3]), int(sys.argv[4]))
    else:
        make_grid_preview(path)