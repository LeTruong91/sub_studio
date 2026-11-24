# Batch Sub Studio (desktop, Python)

Ứng dụng desktop bọc lại giao diện HTML gốc bằng **pywebview**, backend Python
gọi **Gemini TTS** để tạo giọng đọc, và **ffmpeg** để chỉnh tốc độ/pitch +
tạo file `.srt` đồng bộ thời gian.

## Cài đặt

```bash
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Cài thêm **ffmpeg** (bắt buộc, dùng để xử lý audio):
- macOS: `brew install ffmpeg`
- Ubuntu/Debian: `sudo apt install ffmpeg`
- Windows: tải từ https://ffmpeg.org và thêm vào PATH

Lấy API key tại https://aistudio.google.com/apikey rồi đặt biến môi trường:

```bash
export GEMINI_API_KEY="dán-key-của-bạn-vào-đây"   # Windows (PowerShell): $env:GEMINI_API_KEY="..."
```

## Chạy

```bash
python main.py
```

Cửa sổ ứng dụng sẽ mở với giao diện gốc. Luồng hoạt động:

1. **Chọn file** — mở hộp thoại hệ thống thật (không phải input HTML), lấy
   đường dẫn file thật để backend đọc.
2. **Chọn giọng** — một trong 6 giọng Gemini TTS có sẵn trong giao diện.
3. **Tốc độ / pitch** — xử lý hậu kỳ bằng ffmpeg sau khi có audio gốc.
4. **Số phiên bản / đa luồng** — giọng gốc chỉ tạo **một lần** qua Gemini TTS
   (tiết kiệm chi phí & thời gian gọi API); mỗi phiên bản chỉ áp lại
   tốc độ/pitch khác nhau bằng ffmpeg, chạy song song theo số luồng.
5. Nhấn **Tạo phụ đề & audio** → tiến trình và danh sách file được cập nhật
   trực tiếp (Python đẩy sự kiện qua `window.onBackendEvent`).

Kết quả (`.wav` + `.srt`) được lưu trong thư mục `outputs/` cạnh `main.py`.

## Cấu trúc project

```
main.py             # cửa sổ pywebview + Api (cầu nối JS <-> Python)
gemini_tts.py        # gọi Gemini TTS API, ghi ra .wav
audio_utils.py        # chỉnh tốc độ/pitch bằng ffmpeg, đo thời lượng
subtitle_utils.py     # đọc .txt/.srt/.vtt, tạo lại .srt theo thời lượng thật
web/index.html         # giao diện gốc, đã nối vào window.pywebview.api
requirements.txt
```

## Ghi chú kỹ thuật

- Model TTS mặc định: `gemini-2.5-flash-preview-tts` (đổi trong
  `gemini_tts.py` nếu Google cập nhật tên model).
- Tính năng "tính tốc độ theo thời lượng mong muốn" sẽ tự tính hệ số tốc độ
  = (thời lượng audio gốc) / (thời lượng mong muốn) rồi bỏ qua slider tốc độ
  thủ công.
- Vì API TTS tính phí/độ trễ theo mỗi lần gọi, ứng dụng chỉ gọi Gemini **một
  lần** cho mỗi lượt "Tạo", rồi dùng ffmpeg để nhân bản ra N phiên bản khác
  nhau về tốc độ/pitch — bạn có thể đổi lại thành "gọi TTS riêng cho từng
  phiên bản" trong `main.py` (`_generate_batch_worker`) nếu muốn mỗi bản có
  biến thể giọng đọc thực sự khác nhau (không chỉ khác tốc độ/pitch).
- Nên kiểm tra lại chữ ký API mới nhất tại
  https://ai.google.dev/gemini-api/docs/speech-generation trước khi dùng
  cho production, vì API TTS của Google thay đổi khá nhanh.
