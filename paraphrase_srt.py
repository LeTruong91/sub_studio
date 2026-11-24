import ollama
import os
import re
from pathlib import Path

# ==== CẤU HÌNH ====
INPUT_FOLDER = r"C:\reup\srt"
OUTPUT_FOLDER = r"C:\reup\rewritten_srt"   # xuất file .srt mới
RAW_TEXT_FOLDER = r"C:\reup\raw_text"
MODEL_NAME = "qwen2.5:14b"

PROMPT_TEMPLATE = """Hãy viết lại đoạn văn sau bằng tiếng Việt, giữ nguyên ý nghĩa và cảm xúc gốc,
nhưng dùng từ ngữ và cấu trúc câu hoàn toàn khác. Đặc biệt, hãy viết lại cả câu mở đầu
và câu kết thúc theo cách hoàn toàn khác, không giữ nguyên cấu trúc hô gọi hay câu cảm thán gốc.
Văn phong sâu lắng, chân thành, phù hợp chủ đề triết lý tình yêu gia đình.
Viết liền mạch như một bài chia sẻ hoàn chỉnh, không thêm lời giải thích, không thêm tiêu đề,
chỉ trả về đoạn văn đã viết lại.

Đoạn văn gốc:
{text}
"""


class SrtBlock:
    def __init__(self, index, start, end, text):
        self.index = index
        self.start = start
        self.end = end
        self.text = text


def parse_srt(srt_content: str):
    """Parse srt thành danh sách các block (index, start, end, text)."""
    blocks = []
    raw_blocks = re.split(r"\n\s*\n", srt_content.strip())

    for raw in raw_blocks:
        lines = [l.strip() for l in raw.splitlines() if l.strip()]
        if len(lines) < 2:
            continue

        idx_line = lines[0]
        time_line = lines[1]
        text_lines = lines[2:] if len(lines) > 2 else [""]

        time_match = re.match(
            r"(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})", time_line
        )
        if not time_match:
            continue

        start, end = time_match.group(1), time_match.group(2)
        text = " ".join(re.sub(r"<[^>]+>", "", l) for l in text_lines)

        try:
            index = int(idx_line)
        except ValueError:
            index = len(blocks) + 1

        blocks.append(SrtBlock(index, start, end, text))

    return blocks


def split_sentences(text: str):
    """Tách đoạn văn đã paraphrase thành câu, dựa trên dấu . ! ?"""
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    return [s.strip() for s in sentences if s.strip()]


def distribute_sentences(sentences, blocks):
    """
    Ghép danh sách câu đã paraphrase vào các block thời gian gốc,
    không để block nào bị rỗng.

    - Nếu số câu >= số block: chia đều nhiều câu vào mỗi block (mỗi block chắc chắn có ít nhất 1 câu).
    - Nếu số câu < số block: gộp nhiều block thời gian liền kề lại thành 1 khối,
      để mỗi câu có 1 khối thời gian riêng (dùng start của block đầu, end của block cuối trong nhóm).

    Trả về danh sách (start, end, text) đã ghép.
    """
    num_blocks = len(blocks)
    num_sentences = len(sentences)

    if num_blocks == 0:
        return []
    if num_sentences == 0:
        return [(b.start, b.end, "") for b in blocks]

    if num_sentences >= num_blocks:
        result = []
        for j in range(num_blocks):
            low = (j * num_sentences) // num_blocks
            high = ((j + 1) * num_sentences) // num_blocks
            group = sentences[low:high] if high > low else []
            text = " ".join(group)
            result.append((blocks[j].start, blocks[j].end, text))
        return result
    else:
        result = []
        for k in range(num_sentences):
            low = (k * num_blocks) // num_sentences
            high = ((k + 1) * num_blocks) // num_sentences
            if high <= low:
                high = low + 1
            group_blocks = blocks[low:high]
            start = group_blocks[0].start
            end = group_blocks[-1].end
            result.append((start, end, sentences[k]))
        return result


def paraphrase_text(text: str, model_name: str = MODEL_NAME,keep_alive: str = "5m") -> str:
    response = ollama.chat(
        model=model_name,
        messages=[{"role": "user", "content": PROMPT_TEMPLATE.format(text=text)}],
        keep_alive=keep_alive,
    )
    return response["message"]["content"].strip()


def paraphrase_source_file(input_path: str, output_dir: str, model_name: str = MODEL_NAME) -> dict:
    """
    Xử lý 1 file .srt duy nhất (dùng cho app desktop, khác với main() batch-folder
    ở dưới): đọc file, paraphrase toàn bộ nội dung bằng Ollama, rồi lưu ra 2 file
    mới trong `output_dir`:
      - <ten_file>_paraphrased.txt  -> text thuần, dùng làm input cho bước tạo giọng (TTS)
      - <ten_file>_paraphrased.srt  -> bản xem trước có timing (dựa theo timing gốc của
        file .srt đầu vào; timing THẬT sẽ được subtitle_utils.build_srt() tính lại
        sau khi có audio thật, nên file srt này chỉ mang tính tham khảo)

    Trả về dict: {"txt_path", "srt_path", "raw_text", "rewritten_text"}
    """
    input_path = Path(input_path)
    content = input_path.read_text(encoding="utf-8", errors="ignore")

    # ==========================
    # Nếu là file TXT
    # ==========================
    if input_path.suffix.lower() == ".txt":
        raw_text = re.sub(r"\s+", " ", content).strip()

        rewritten = paraphrase_text(raw_text, model_name=model_name)

        out_dir = Path(output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        base_name = input_path.stem

        txt_path = out_dir / f"{base_name}_paraphrased.txt"
        txt_path.write_text(rewritten.strip() + "\n", encoding="utf-8")

        # txt không có timing nên không sinh srt
        return {
            "txt_path": str(txt_path),
            "srt_path": None,
            "raw_text": raw_text,
            "rewritten_text": rewritten,
        }

    # ==========================
    # Nếu là file SRT
    # ==========================
    blocks = parse_srt(content)

    if not blocks:
        raise ValueError(f"Không parse được nội dung .srt hợp lệ trong file: {input_path.name}")

    raw_text = " ".join(b.text for b in blocks)
    raw_text = re.sub(r"\s+", " ", raw_text).strip()

    rewritten = paraphrase_text(raw_text, model_name=model_name)

    sentences = split_sentences(rewritten)
    merged_blocks = distribute_sentences(sentences, blocks)
    # content = input_path.read_text(encoding="utf-8", errors="ignore")

    # blocks = parse_srt(content)
    # if not blocks:
    #     raise ValueError(f"Không parse được nội dung .srt hợp lệ trong file: {input_path.name}")

    # raw_text = " ".join(b.text for b in blocks)
    # raw_text = re.sub(r"\s+", " ", raw_text).strip()

    # rewritten = paraphrase_text(raw_text, model_name=model_name)
    # sentences = split_sentences(rewritten)
    # merged_blocks = distribute_sentences(sentences, blocks)

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    base_name = input_path.stem

    txt_path = out_dir / f"{base_name}_paraphrased.txt"
    srt_path = out_dir / f"{base_name}_paraphrased.srt"

    txt_path.write_text(rewritten.strip() + "\n", encoding="utf-8")
    write_srt(merged_blocks, str(srt_path))

    return {
        "txt_path": str(txt_path),
        "srt_path": str(srt_path),
        "raw_text": raw_text,
        "rewritten_text": rewritten,
    }


def write_srt(merged_blocks, output_path):
    """merged_blocks: danh sách (start, end, text)"""
    with open(output_path, "w", encoding="utf-8") as f:
        for i, (start, end, text) in enumerate(merged_blocks, 1):
            if not text.strip():
                continue
            f.write(f"{i}\n")
            f.write(f"{start} --> {end}\n")
            f.write(f"{text}\n\n")
def unload_model(model_name: str = MODEL_NAME):
    """Gọi hàm này sau khi xong toàn bộ batch để giải phóng VRAM/RAM ngay,
    thay vì đợi Ollama tự unload sau 5 phút idle mặc định."""
    try:
        ollama.chat(
            model=model_name,
            messages=[{"role": "user", "content": "."}],
            keep_alive=0,
        )
    except Exception as e:
        print(f"Không unload được model {model_name}: {e}")

def main():
    os.makedirs(OUTPUT_FOLDER, exist_ok=True)
    os.makedirs(RAW_TEXT_FOLDER, exist_ok=True)

    files = [f for f in os.listdir(INPUT_FOLDER) if f.lower().endswith(".srt")]
    if not files:
        print(f"Không tìm thấy file .srt nào trong {INPUT_FOLDER}")
        return

    print(f"Tìm thấy {len(files)} file .srt. Bắt đầu xử lý...\n")

    for i, filename in enumerate(files, 1):
        input_path = os.path.join(INPUT_FOLDER, filename)
        base_name = os.path.splitext(filename)[0]
        raw_text_path = os.path.join(RAW_TEXT_FOLDER, base_name + ".txt")
        output_path = os.path.join(OUTPUT_FOLDER, base_name + ".srt")

        if os.path.exists(output_path):
            print(f"[{i}/{len(files)}] Bỏ qua (đã xử lý trước đó): {filename}")
            continue

        with open(input_path, "r", encoding="utf-8", errors="ignore") as f:
            srt_content = f.read()

        blocks = parse_srt(srt_content)
        if not blocks:
            print(f"[{i}/{len(files)}] Bỏ qua (không parse được srt): {filename}")
            continue

        full_text = " ".join(b.text for b in blocks)
        full_text = re.sub(r"\s+", " ", full_text).strip()

        with open(raw_text_path, "w", encoding="utf-8") as f:
            f.write(full_text)

        print(f"[{i}/{len(files)}] Đang paraphrase: {filename} ...")
        try:
            rewritten = paraphrase_text(full_text)
            sentences = split_sentences(rewritten)
            merged_blocks = distribute_sentences(sentences, blocks)
            write_srt(merged_blocks, output_path)
            print(f"    -> Xong: {base_name}.srt")
        except Exception as e:
            print(f"    -> LỖI với file {filename}: {e}")

    print("\nHoàn tất toàn bộ!")
    print(f"- Text gốc đã trích xuất: {RAW_TEXT_FOLDER}")
    print(f"- File srt đã viết lại: {OUTPUT_FOLDER}")


if __name__ == "__main__":
    main()