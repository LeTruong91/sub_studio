"""
subtitle_utils.py
------------------
Parse .txt / .srt / .vtt input files into a list of "cues" (text blocks),
and re-render cues into a timed .srt file once we know the final audio
duration (which depends on the TTS output + the speed factor applied).

A "cue" is a dict: {"text": str, "weight": float}
- weight is used to distribute the total audio duration across cues,
  proportional to how much "reading time" each cue should take
  (based on character count).
"""
import re
from pathlib import Path


def _ms_to_srt_timestamp(ms: int) -> str:
    ms = max(0, int(ms))
    hours, rem = divmod(ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    seconds, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def _split_into_sentences(text: str):
    """Split plain text into sentence-ish chunks for subtitle cueing."""
    text = text.strip()
    if not text:
        return []
    # Split on sentence-ending punctuation, keep it simple and predictable.
    parts = re.split(r"(?<=[.!?…])\s+|\n+", text)
    return [p.strip() for p in parts if p.strip()]


def parse_srt(content: str):
    """Parse an existing .srt file's text into cues (timing is discarded;
    we regenerate timing from the new TTS audio duration)."""
    blocks = re.split(r"\n\s*\n", content.strip())
    cues = []
    for block in blocks:
        lines = [l for l in block.splitlines() if l.strip()]
        if not lines:
            continue
        # Drop the index line (pure digits) and the "00:00:00,000 --> ..." line
        text_lines = [
            l for l in lines
            if not l.strip().isdigit() and "-->" not in l
        ]
        text = " ".join(text_lines).strip()
        if text:
            cues.append({"text": text, "weight": len(text)})
    return cues


def parse_vtt(content: str):
    content = re.sub(r"^WEBVTT.*?\n", "", content, flags=re.IGNORECASE)
    return parse_srt(content)


def parse_txt(content: str):
    return [{"text": s, "weight": len(s)} for s in _split_into_sentences(content)]


def load_cues(file_path: str):
    """Read a source file and return a list of cues, based on its extension."""
    path = Path(file_path)
    content = path.read_text(encoding="utf-8", errors="ignore")
    ext = path.suffix.lower()
    if ext == ".srt":
        cues = parse_srt(content)
    elif ext == ".vtt":
        cues = parse_vtt(content)
    else:
        cues = parse_txt(content)
    if not cues:
        raise ValueError("Không tìm thấy nội dung văn bản hợp lệ trong file nguồn.")
    return cues


def build_srt(cues, total_duration_seconds: float, min_cue_seconds: float = 0.8, offset_seconds: float = 0) -> str:
    """Distribute total_duration_seconds across cues proportional to their
    weight (character count), then render as .srt text."""
    total_ms = max(1, int(total_duration_seconds * 1000))
    total_weight = sum(c["weight"] for c in cues) or 1
    offset_ms = max(0, int(float(offset_seconds or 0) * 1000))

    # First pass: proportional allocation
    raw_durations = [max(1, round(total_ms * (c["weight"] / total_weight))) for c in cues]

    # Enforce a minimum cue length, then rescale to still sum to total_ms
    min_ms = int(min_cue_seconds * 1000)
    raw_durations = [max(min_ms, d) for d in raw_durations]
    scale = total_ms / sum(raw_durations)
    durations = [max(1, round(d * scale)) for d in raw_durations]

    lines = []
    cursor = 0
    for i, (cue, dur) in enumerate(zip(cues, durations), start=1):
        start = cursor + offset_ms
        end = cursor + dur + offset_ms
        cursor = cursor + dur
        lines.append(str(i))
        lines.append(f"{_ms_to_srt_timestamp(start)} --> {_ms_to_srt_timestamp(end)}")
        lines.append(cue["text"])
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def full_script_text(cues) -> str:
    """Join all cue text into one script to send to the TTS engine."""
    return "\n".join(c["text"] for c in cues)
