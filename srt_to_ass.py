import re
import random
from dataclasses import dataclass


@dataclass
class AssStylePreset:
    FontName: str = "Arial"
    FontSize: float = 70
    PrimaryColor: str = "&H00FFFFFF"   # màu chữ mặc định (trắng) - cũng là màu "chưa hát tới" trong karaoke nếu không set riêng
    HighlightColor: str = "&H0000FFFF"  # màu khi từ đang "pop" / đang được hát tới (vàng, format &H00BBGGRR)
    KaraokeBaseColor: str = None        # màu chữ TRƯỚC khi được hát tới (SecondaryColour). Nếu None -> dùng PrimaryColor
    OutlineColor: str = "&H00000000"
    Bold: bool = True
    ScaleX: int = 100
    ScaleY: int = 100
    Spacing: int = 0
    Rotation: int = 0
    Outline: int = 3
    Shadow: int = 0
    Alignment: int = 5   # 5 = center middle (dễ canh giữa khung hình dọc)
    MarginL: int = 20
    MarginR: int = 20
    MarginV: int = 40
    PosX: int = 0
    PosY: int = 0
    BorderStyle: int = 1  # 1 = viền; 3 = nền hộp (TikTok caption)

    # Cấu hình hiệu ứng "pop"
    PopScaleFrom: int = 130      # % scale lúc bắt đầu xuất hiện
    PopScaleTo: int = 100        # % scale ổn định
    PopDurationMs: int = 120     # thời gian animate pop-in (ms)

    # Cấu hình hiệu ứng "karaoke"
    KaraokeSmooth: bool = True   # True -> dùng \\kf (sweep mượt), False -> dùng \\k (đổi màu tức thì theo khối)
    KaraokePopScale: int = 0     # % scale phóng to thêm khi từ đang active (0 = tắt hiệu ứng phóng to, giữ karaoke "thuần")

    Uppercase: bool = False      # True -> viết hoa toàn bộ chữ hiển thị


def _parse_srt_time(s: str):
    s = s.replace(",", ".")
    h, m, rest = s.split(":")
    sec, ms = rest.split(".")
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000.0


def _cs_to_ass_time(total_cs: float) -> str:
    total_seconds = total_cs / 100.0
    hours = int(total_seconds // 3600)
    minutes = int((total_seconds % 3600) // 60)
    seconds = int(total_seconds % 60)
    centiseconds = int(round((total_seconds - int(total_seconds)) * 100))
    return f"{hours}:{minutes:02d}:{seconds:02d}.{centiseconds:02d}"


def _alloc_word_durations(words, total_cs: float):
    """Phân bổ centiseconds cho từng từ dựa theo độ dài ký tự (để nhịp tự nhiên hơn chia đều)."""
    if not words:
        return []

    total = max(len(words), round(total_cs))

    weights = []
    for word in words:
        clean = re.sub(r"[^\w]", "", word, flags=re.UNICODE)
        length = max(len(clean), 1)
        weight = length * (0.9 + random.random() * 0.2)
        weights.append(weight)

    sum_weight = sum(weights)
    raw = [total * w / sum_weight for w in weights]
    alloc = [max(1, int(r)) for r in raw]

    remainder = total - sum(alloc)
    order = sorted(range(len(raw)), key=lambda i: raw[i] - int(raw[i]), reverse=True)

    idx = 0
    while remainder > 0:
        alloc[order[idx % len(order)]] += 1
        remainder -= 1
        idx += 1

    return alloc


def _fmt_style_fs(fs) -> str:
    n = float(fs or 0)
    if n < 1:
        n = 1.0
    if abs(n - round(n)) < 0.005:
        return str(int(round(n)))
    return f"{n:.2f}"


def _chunk_words(words, chunk_size=1):
    return [words[i:i + chunk_size] for i in range(0, len(words), chunk_size)]


def _wrap_words_to_box(words, font_size: int, box_w_px: float) -> str:
    """Xuống dòng theo bề rộng khung sub (ước lượng ~0.55 * fontsize / ký tự)."""
    if not words:
        return ""
    max_chars = max(6, int(float(box_w_px or 0) / max(8, float(font_size) * 0.55)))
    lines = []
    cur = ""
    for w in words:
        trial = (cur + " " + w).strip()
        if not cur or len(trial) <= max_chars:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return r"\N".join(lines)


def _pop_text(text: str, preset: AssStylePreset) -> str:
    """
    Tạo hiệu ứng pop: chữ xuất hiện với scale lớn hơn + màu highlight,
    rồi thu về scale bình thường + màu chính trong PopDurationMs.
    Không dùng \\kf (karaoke fill) -> không có hiệu ứng "chảy màu".
    """
    ms = preset.PopDurationMs
    tag = (
        f"{{\\fscx{preset.PopScaleFrom}\\fscy{preset.PopScaleFrom}"
        f"\\c{preset.HighlightColor}"
        f"\\t(0,{ms},\\fscx{preset.PopScaleTo}\\fscy{preset.PopScaleTo}\\c{preset.PrimaryColor})}}"
    )
    return f"{tag}{text}"


def _karaoke_text(words, word_durations_cs, preset: AssStylePreset) -> str:
    """
    Tạo 1 dòng text karaoke chuẩn ASS: mỗi từ được bọc bởi \\k hoặc \\kf
    với thời lượng (centiseconds) tương ứng.

    - \\kf<n>  -> "sweep" mượt: màu quét từ SecondaryColour sang PrimaryColour trong n cs
    - \\k<n>   -> đổi màu tức thì khi tới lượt từ đó (không mượt)

    Nếu KaraokePopScale > 0, từ đang active còn được phóng to nhẹ rồi thu lại,
    kết hợp cảm giác "nảy" giống karaoke video hiện đại.
    """
    tag_name = "kf" if preset.KaraokeSmooth else "k"
    parts = []

    for word, dur_cs in zip(words, word_durations_cs):
        dur_cs = max(1, int(round(dur_cs)))

        if preset.KaraokePopScale and preset.KaraokePopScale > 0:
            # Thêm hiệu ứng phóng to nhẹ trong lúc từ đang "sáng"
            dur_ms = dur_cs * 10
            extra = (
                f"\\fscx{preset.KaraokePopScale}\\fscy{preset.KaraokePopScale}"
                f"\\t(0,{dur_ms},\\fscx100\\fscy100)"
            )
            parts.append(f"{{\\{tag_name}{dur_cs}{extra}}}{word} ")
        else:
            parts.append(f"{{\\{tag_name}{dur_cs}}}{word} ")

    return "".join(parts).rstrip()


def srt_to_ass(srt_file: str, ass_file: str, preset: AssStylePreset,
               play_res_x: int = 1080, play_res_y: int = 1920,
               words_per_chunk: int = 1,
               sub_x: float = None, sub_y: float = None,
               sub_width: float = None, sub_height: float = None,
               style_mode: str = "pop",
               clip_rect=None):
    """
    style_mode:
      default   — nguyên câu, tĩnh
      karaoke   — highlight từng từ (TikTok)
      pop       — nảy từng cụm từ
      one_word  — chỉ hiện từ đang đọc (TikTok Auto Captions)
      box       — chữ trên nền hộp theo khung sub
      bounce    — cả câu nảy vào rồi đứng
      fade      — hiện / mờ dần
    clip_rect: (x1, y1, x2, y2) pixel — cắt chữ trong khung sub (kiểu hộp)
    """
    allowed = ("default", "karaoke", "pop", "one_word", "box", "bounce", "fade")
    if style_mode not in allowed:
        raise ValueError(f'style_mode phải là một trong: {", ".join(allowed)}')

    ass_lines = []

    box_w = sub_width if sub_width is not None else 0
    box_h = sub_height if sub_height is not None else 0
    if sub_x is not None and sub_y is not None:
        # x, y góc trên-trái (tỉ lệ 0-1) -> tâm khung (px), Alignment 5
        preset.PosX = int((sub_x + box_w / 2) * play_res_x)
        preset.PosY = int((sub_y + box_h / 2) * play_res_y)
    else:
        preset.PosX = play_res_x // 2 + random.randint(-10, 10)
        preset.PosY = int(play_res_y * 0.83) + random.randint(-20, 20)

    if style_mode == "box":
        preset.Alignment = 5
        if box_h and box_h > 0:
            box_h_px = box_h * play_res_y if box_h <= 1.5 else box_h
            max_fs = max(10, int(box_h_px * 0.48))
            if int(preset.FontSize or 0) > max_fs:
                preset.FontSize = max_fs

    ass_lines.append("[Script Info]")
    ass_lines.append("ScriptType: v4.00+")
    ass_lines.append(f"PlayResX: {play_res_x}")
    ass_lines.append(f"PlayResY: {play_res_y}")
    ass_lines.append("ScaledBorderAndShadow: yes")
    if style_mode == "box":
        ass_lines.append("WrapStyle: 2")
    ass_lines.append("")

    ass_lines.append("[V4+ Styles]")
    ass_lines.append(
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding"
    )

    if style_mode == "karaoke":
        primary_colour = preset.HighlightColor
        secondary_colour = preset.KaraokeBaseColor or preset.PrimaryColor
    else:
        primary_colour = preset.PrimaryColor
        secondary_colour = "&H000000FF"

    # Hộp thật vẽ bằng drawbox theo khung layer; ASS chỉ chữ (không BorderStyle 3)
    border_style = preset.BorderStyle or 1
    back_colour = "&H00000000"
    outline_w = preset.Outline

    ass_lines.append(
        f"Style: Default,"
        f"{preset.FontName},"
        f"{_fmt_style_fs(preset.FontSize)},"
        f"{primary_colour},"
        f"{secondary_colour},"
        f"{preset.OutlineColor},"
        f"{back_colour},"
        f"{-1 if preset.Bold else 0},0,0,0,"
        f"{preset.ScaleX},"
        f"{preset.ScaleY},"
        f"{preset.Spacing},"
        f"{preset.Rotation},"
        f"{border_style},"
        f"{outline_w},"
        f"{preset.Shadow},"
        f"{preset.Alignment},"
        f"{preset.MarginL},"
        f"{preset.MarginR},"
        f"{preset.MarginV},1"
    )
    ass_lines.append("")

    ass_lines.append("[Events]")
    ass_lines.append("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text")

    with open(srt_file, "r", encoding="utf-8") as f:
        text = f.read()

    blocks = re.split(r"\r?\n\r?\n", text.strip())

    for block in blocks:
        lines = re.split(r"\r\n|\n", block)
        if len(lines) < 3:
            continue

        time_line = lines[1]
        match = re.search(
            r"(\d\d:\d\d:\d\d,\d\d\d)\s*-->\s*(\d\d:\d\d:\d\d,\d\d\d)",
            time_line,
        )
        if not match:
            continue

        ts_start = _parse_srt_time(match.group(1))
        ts_end = _parse_srt_time(match.group(2))
        duration_cs = (ts_end - ts_start) * 100

        subtitle = " ".join(lines[2:]).strip()
        subtitle = subtitle.replace(",", "")          # bỏ dấu phẩy
        subtitle = re.sub(r"\s+", " ", subtitle).strip()  # gộp khoảng trắng thừa nếu có

        if preset.Uppercase:
            subtitle = subtitle.upper()

        words = [w for w in re.split(r"\s+", subtitle) if w]
        if not words:
            continue

        word_durations = _alloc_word_durations(words, duration_cs)
        start_offset_cs = ts_start * 100

        clip_part = ""
        if clip_rect and len(clip_rect) == 4:
            x1, y1, x2, y2 = [int(v) for v in clip_rect]
            clip_part = f"\\clip({x1},{y1},{x2},{y2})"
        pos_tag = f"{{{clip_part}\\an{preset.Alignment}\\pos({preset.PosX},{preset.PosY})}}"
        line_size = max(1, int(words_per_chunk or 1))
        if style_mode == "box":
            box_w_px = (box_w * play_res_x) if box_w <= 1.5 else float(box_w or 0)
            wrapped = _wrap_words_to_box(words, int(preset.FontSize or 18), box_w_px)
        else:
            wrapped = r"\N".join(" ".join(c) for c in _chunk_words(words, line_size))

        def _add(start_cs, end_cs, body):
            ass_lines.append(
                f"Dialogue: 0,{_cs_to_ass_time(start_cs)},{_cs_to_ass_time(end_cs)},Default,,0,0,0,,"
                f"{pos_tag}{body}"
            )

        if style_mode in ("default", "box"):
            _add(ts_start * 100, ts_end * 100, wrapped)
            continue

        if style_mode == "bounce":
            _add(ts_start * 100, ts_end * 100, _pop_text(wrapped, preset))
            continue

        if style_mode == "fade":
            _add(ts_start * 100, ts_end * 100, r"{\fad(140,140)}" + wrapped)
            continue

        word_chunks = _chunk_words(words, line_size)
        dur_chunks = _chunk_words(word_durations, line_size)
        cursor_cs = 0.0
        for w_chunk, d_chunk in zip(word_chunks, dur_chunks):
            chunk_total_cs = sum(d_chunk)
            chunk_start_cs = start_offset_cs + cursor_cs
            chunk_end_cs = chunk_start_cs + chunk_total_cs
            display_text = " ".join(w_chunk)

            if style_mode == "karaoke":
                body = _karaoke_text(w_chunk, d_chunk, preset)
            elif style_mode == "one_word":
                body = (
                    r"{\fscx118\fscy118\t(0,90,\fscx100\fscy100)\c"
                    + preset.HighlightColor
                    + "}"
                    + display_text
                )
            else:
                body = _pop_text(display_text, preset)

            _add(chunk_start_cs, chunk_end_cs, body)
            cursor_cs += chunk_total_cs

    with open(ass_file, "w", encoding="utf-8") as f:
        f.write("\n".join(ass_lines) + "\n")


if __name__ == "__main__":
    # Ví dụ sử dụng
    preset = AssStylePreset(
        FontName="Arial",
        FontSize=70,
        PrimaryColor="&H00FFFFFF",     # sẽ dùng làm màu "chưa hát tới" (Secondary) trong karaoke
        HighlightColor="&H0000FFFF",   # màu vàng khi từ được "hát" tới
        Outline=3,
        KaraokeSmooth=True,
        KaraokePopScale=0,             # đặt vd. 115 nếu muốn từ hơi phóng to lúc active
    )

    # Ví dụ: xuất bản karaoke
    # srt_to_ass("input.srt", "output_karaoke.ass", preset, style_mode="karaoke")

    # Ví dụ: xuất bản pop (như code gốc)
    # srt_to_ass("input.srt", "output_pop.ass", preset, style_mode="pop", words_per_chunk=1)