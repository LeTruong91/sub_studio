"""
audio_utils.py
--------------
Wraps ffmpeg for:
  - probing audio duration
  - changing speed (tempo) without affecting pitch
  - changing pitch (semitones) without affecting tempo
  - combined speed + pitch in one pass

Requires ffmpeg + ffprobe to be installed and on PATH.
"""
import json
import math
import subprocess
from pathlib import Path
import base64
import sys
import tempfile
import os
import uuid
from subprocess_utils import run_hidden
if getattr(sys, "frozen", False):
    # Đang chạy từ file exe đã build (PyInstaller)
    BASE_DIR = Path(sys.executable).resolve().parent
else:
    # Đang chạy bằng python main.py (dev mode)
    BASE_DIR = Path(__file__).resolve().parent
# BASE_DIR = Path(__file__).resolve().parent
FFMPEG_EXE = BASE_DIR / "ffmpeg" / "ffmpeg.exe"
FFPROBE_EXE = BASE_DIR / "ffmpeg" / "ffprobe.exe"
class FFmpegError(RuntimeError):
    pass


def _run(cmd):
    result = run_hidden(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        raise FFmpegError(result.stderr.decode("utf-8", errors="ignore"))
    return result


def probe_duration_seconds(path: str) -> float:
    cmd = [
        str(FFPROBE_EXE),
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json",
        str(path),
    ]
    out = _run(cmd).stdout
    data = json.loads(out)
    return float(data["format"]["duration"])


def _atempo_chain(factor: float) -> str:
    """ffmpeg's atempo filter only accepts 0.5-2.0 per instance.
    Chain multiple atempo filters to reach factors outside that range."""
    if factor <= 0:
        raise ValueError("Speed factor must be positive")
    filters = []
    remaining = factor
    while remaining > 2.0:
        filters.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        filters.append("atempo=0.5")
        remaining /= 0.5
    filters.append(f"atempo={remaining:.6f}")
    return ",".join(filters)

def get_video_info(path):
    try:
        cmd = [
            str(FFPROBE_EXE),
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-show_format",
            path
        ]

        result = run_hidden(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8"
        )

        data = json.loads(result.stdout)

        stream = next(
            (s for s in data["streams"] if s["codec_type"] == "video"),
            {}
        )

        duration = float(data["format"]["duration"])
        width = stream.get("width", 0)
        height = stream.get("height", 0)

        return duration, width, height

    except Exception:
        return 0, 0, 0
def get_video_thumbnail(path):
    try:
        # thumb_path = os.path.join(
        # tempfile.gettempdir(),
        # Path(path).stem + "_thumb.jpg")
        thumb_path = os.path.join(
        tempfile.gettempdir(),
        Path(path).stem + "_" + uuid.uuid4().hex[:8] + "_thumb.jpg")
        cmd = [
        str(FFMPEG_EXE),
            "-y",
            "-ss", "00:00:01",
            "-i", path,
            "-frames:v", "1",
            "-vf", "scale=180:-1",
            thumb_path
        ]

        _run(cmd)

        if not os.path.exists(thumb_path):
            return None

        with open(thumb_path, "rb") as f:
            data = base64.b64encode(f.read()).decode()

        os.remove(thumb_path)
        return "data:image/jpeg;base64," + data    
    except Exception as e:
        return None
        

def format_duration(sec):
    sec = int(sec)
    h = sec // 3600
    m = (sec % 3600) // 60
    s = sec % 60
    return f"{h:02}:{m:02}:{s:02}"
def render_audio(
    input_path: str,
    output_path: str,
    speed: float = 1.0,
    pitch_semitones: float = 0.0,
    sample_rate: int = 24000,
):
    """
    Apply pitch shift (semitones, tempo-compensated so duration is unaffected
    by the pitch shift itself) followed by the user's requested speed change.
    """
    filters = []

    if abs(pitch_semitones) > 1e-6:
        pitch_ratio = math.pow(2, pitch_semitones / 12)

        filters.append(
            f"rubberband=pitch={pitch_ratio}:formant=preserved"
        )

    if abs(speed - 1.0) > 1e-6:
        filters.append(
            f"rubberband=tempo={speed}"
        )

    filter_arg = ",".join(filters) if filters else "anull"

    cmd = [
        str(FFMPEG_EXE),
        "-y",
        "-i", str(input_path),
        "-filter:a", filter_arg,
        "-ar", str(sample_rate),
        str(output_path),
    ]
    _run(cmd)
    return output_path


def speed_for_target_duration(current_duration: float, target_duration: float) -> float:
    """Return the tempo factor needed to stretch/compress current_duration
    audio to target_duration."""
    if target_duration <= 0:
        raise ValueError("Target duration must be positive")
    return current_duration / target_duration
