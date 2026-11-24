"""vera_tts.py — gọi Server Voice theo chuẩn OpenAI của VieNeu-TTS.

Server: apps/openai_speech.py của VieNeu-TTS (model v3 Turbo), chạy ở
http://127.0.0.1:8282 (đặt PORT=8282 khi chạy server).

Các đường gọi:
- GET  /v1/voices        -> danh sách giọng (preset + giọng clone đã đăng ký)
- POST /v1/voices        -> đăng ký giọng clone 1 lần (tên + file mẫu), rồi gọi bằng tên
- POST /v1/audio/speech  -> tạo giọng, trả thẳng PCM (không qua job/download)

Khác với server cũ: không còn /synthesize_srt, /synthesize, /voice_profile,
không còn job_id/download_url. Việc khớp thời gian từng câu (match_timing)
giờ làm ở phía app: mỗi câu gọi 1 lần rồi tăng tốc / đệm im lặng cho vừa mốc.

Các tham số cũ ref_text / language / num_step / instruct: model v3 Turbo
không dùng nữa nên chỉ nhận vào cho tương thích, không gửi lên server.
Tốc độ / cao độ vẫn do app chỉnh sau khi có file wav (audio_utils.render_audio).
"""
import json
import os
import re
import shutil
import tempfile
import wave
from pathlib import Path

import requests

import audio_utils

API_BASE_URL = "http://127.0.0.1:8282/v1"  # server chuẩn VieNeu (apps/openai_speech.py)
TIMEOUT = 600  # giây - tổng hợp SRT dài có thể mất vài phút
CUE_TIMEOUT = 120  # giây - tối đa cho 1 câu
SAMPLE_RATE = 24000  # xin thẳng 24kHz từ server, khớp với app
MODEL_NAME = "vieneu-v3-turbo"
TEMP_CLONE_NAME = "Nhân bản tạm thời"  # giọng clone dùng 1 lần, không lưu
MAX_SPEED = 3.0  # tăng tốc tối đa khi khớp thời gian từng câu
_CLIP_EXTS = (".wav", ".mp3", ".flac", ".ogg", ".m4a")
_NO_PROXY = {"http": None, "https": None}


# --------------------------------------------------------------------------
# Gọi API
# --------------------------------------------------------------------------
def _raise_for_status(resp):
    try:
        resp.raise_for_status()
    except requests.HTTPError:
        detail = ""
        try:
            data = resp.json()
            detail = data.get("detail") or data.get("message") or str(data)
        except Exception:
            detail = (resp.text or "").strip()[:300]
        raise RuntimeError(
            f"Server Voice lỗi ({resp.status_code}): {detail or resp.reason}"
        )


def _server_voices():
    """Danh sách giọng trên server: [{name, id, description, ...}]."""
    resp = requests.get(
        f"{API_BASE_URL}/voices", timeout=TIMEOUT, proxies=_NO_PROXY
    )
    _raise_for_status(resp)
    data = resp.json()
    if isinstance(data, dict):
        data = data.get("data", [])
    return data if isinstance(data, list) else []


def _voice_on_server(name):
    try:
        return any(v.get("name") == name for v in _server_voices())
    except Exception:
        return False


def _enroll_voice(name, ref_audio_path, description=""):
    """Đăng ký giọng clone trên server (tên + file mẫu). Trả về JSON của server."""
    with open(ref_audio_path, "rb") as f:
        resp = requests.post(
            f"{API_BASE_URL}/voices",
            data={
                "name": name,
                "denoise": "true",
                "description": description or "",
            },
            files={"file": (Path(ref_audio_path).name, f)},
            timeout=TIMEOUT,
            proxies=_NO_PROXY,
        )
    _raise_for_status(resp)
    return resp.json()


def _speak(text, voice):
    """Tạo giọng cho 1 đoạn chữ, trả về PCM s16le 24kHz (bytes)."""
    resp = requests.post(
        f"{API_BASE_URL}/audio/speech",
        json={
            "model": MODEL_NAME,
            "input": text,
            "voice": voice,
            "response_format": "pcm",
            "sample_rate": SAMPLE_RATE,
            "stream_format": "audio",
        },
        timeout=CUE_TIMEOUT,
        stream=True,
        proxies=_NO_PROXY,
    )
    _raise_for_status(resp)
    chunks = []
    for chunk in resp.iter_content(chunk_size=8192):
        if chunk:
            chunks.append(chunk)
    return b"".join(chunks)


# --------------------------------------------------------------------------
# Giọng clone đã lưu (đăng ký lại sau khi server khởi động lại)
# --------------------------------------------------------------------------
def _safe_voice_filename(name):
    safe = re.sub(r'[\\/:*?"<>|]', "_", str(name).strip()) or "Voice"
    return safe[:60]


def _find_saved_clip(voices_dir, name):
    if not voices_dir:
        return None
    base = Path(voices_dir) / _safe_voice_filename(name)
    for ext in _CLIP_EXTS:
        p = base.with_suffix(ext)
        if p.exists():
            return str(p)
    return None


def _save_clip_locally(voices_dir, name, ref_audio_path):
    """Giữ lại file mẫu giọng trên máy để đăng ký lại được khi server mất giọng."""
    if not voices_dir or not ref_audio_path:
        return None
    folder = Path(voices_dir)
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / (
        _safe_voice_filename(name) + Path(ref_audio_path).suffix.lower()
    )
    shutil.copyfile(ref_audio_path, dest)
    return str(dest)


def _save_voice_meta(voices_dir, name, description, gender):
    """Giu lai mo ta + gioi tinh cua giong da luu (file .json canh file mau),
    de dang ky lai dung mo ta khi server khoi dong lai lam mat giong."""
    if not voices_dir:
        return None
    folder = Path(voices_dir)
    folder.mkdir(parents=True, exist_ok=True)
    meta_path = folder / (_safe_voice_filename(name) + ".json")
    meta_path.write_text(
        json.dumps({"description": description or "", "gender": gender or ""},
                   ensure_ascii=False),
        encoding="utf-8",
    )
    return str(meta_path)


def _load_voice_meta(voices_dir, name):
    if not voices_dir:
        return None
    meta_path = Path(voices_dir) / (_safe_voice_filename(name) + ".json")
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _resolve_voice(
    voice,
    ref_audio=None,
    enable_clone_save=False,
    nameCloneSave=None,
    desCLoneSave=None,
    voices_dir=None,
    genderCloneSave=None,
):
    """Trả về tên giọng sẽ dùng cho các câu (đã đăng ký xong trên server)."""
    if ref_audio:
        # Nhân bản từ file mẫu vừa chọn: đăng ký 1 lần rồi gọi bằng tên.
        name = (nameCloneSave or "NameVoice") if enable_clone_save else TEMP_CLONE_NAME
        _enroll_voice(name, ref_audio, desCLoneSave or "")
        if enable_clone_save:
            _save_clip_locally(voices_dir, name, ref_audio)
            _save_voice_meta(voices_dir, name, desCLoneSave or "",
                             genderCloneSave or "")
        return name

    name = (voice or "Minh Đức").strip()
    if _voice_on_server(name):
        return name
    # Giọng đã lưu nhưng server vừa khởi động lại nên mất: đăng ký lại từ
    # file mẫu đã giữ trên máy.
    clip = _find_saved_clip(voices_dir, name)
    if clip:
        meta = _load_voice_meta(voices_dir, name)
        _enroll_voice(name, clip,
                      (meta or {}).get("description", "") or "")
        return name
    raise RuntimeError(
        f"Giọng '{name}' chưa có trên Server Voice. "
        "Hãy mở Server Voice rồi bấm tải lại giọng, hoặc chọn giọng khác."
    )


# --------------------------------------------------------------------------
# Âm thanh (PCM 16-bit, mono, 24kHz)
# --------------------------------------------------------------------------
def _pcm_seconds(pcm):
    return len(pcm) / (2 * SAMPLE_RATE)


def _silence(seconds):
    n = max(0, int(round(seconds * SAMPLE_RATE * 2)))
    return b"\x00" * n


def _write_wav(path, pcm):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)


def _read_wav_pcm(path):
    with wave.open(str(path), "rb") as w:
        return w.readframes(w.getnframes())


def _fit_cue(pcm, slot_seconds, tmpdir):
    """Khớp 1 câu vào đúng độ dài mốc: dài hơn thì tăng tốc, ngắn hơn đệm im lặng."""
    dur = _pcm_seconds(pcm)
    if dur <= slot_seconds:
        return pcm + _silence(slot_seconds - dur)
    speed = min(dur / slot_seconds, MAX_SPEED)
    src = Path(tmpdir) / "cue_src.wav"
    dst = Path(tmpdir) / "cue_dst.wav"
    _write_wav(src, pcm)
    audio_utils.render_audio(str(src), str(dst), speed=speed, sample_rate=SAMPLE_RATE)
    fitted = _read_wav_pcm(dst)
    fdur = _pcm_seconds(fitted)
    if fdur > slot_seconds:
        fitted = fitted[: int(slot_seconds * SAMPLE_RATE * 2)]
    elif fdur < slot_seconds:
        fitted = fitted + _silence(slot_seconds - fdur)
    return fitted


# --------------------------------------------------------------------------
# Đọc file nguồn (.srt / .vtt có mốc giờ, .txt thì không)
# --------------------------------------------------------------------------
_TS_RE = re.compile(
    r"(?:(\d+):)?(\d+):(\d+)[,.](\d+)\s*-->\s*(?:(\d+):)?(\d+):(\d+)[,.](\d+)"
)


def _ts_to_seconds(h, m, s, ms):
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def _parse_source(path):
    text = Path(path).read_text(encoding="utf-8", errors="ignore")
    ext = Path(path).suffix.lower()
    if ext in (".srt", ".vtt"):
        if ext == ".vtt":
            text = re.sub(r"^WEBVTT.*?\n", "", text, flags=re.IGNORECASE)
        cues = []
        for block in re.split(r"\n\s*\n", text.strip()):
            lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
            if not lines:
                continue
            timing = next((ln for ln in lines if "-->" in ln), None)
            words = " ".join(
                ln for ln in lines if not ln.strip().isdigit() and "-->" not in ln
            ).strip()
            if not words:
                continue
            cue = {"text": words}
            if timing:
                m = _TS_RE.search(timing)
                if m:
                    cue["start"] = _ts_to_seconds(m.group(1), m.group(2), m.group(3), m.group(4))
                    cue["end"] = _ts_to_seconds(m.group(5), m.group(6), m.group(7), m.group(8))
            cues.append(cue)
        return cues
    # .txt: tách thành từng câu, không có mốc giờ
    parts = [
        p.strip()
        for p in re.split(r"(?<=[.!?…])\s+|\n+", text.strip())
        if p.strip()
    ]
    return [{"text": p} for p in parts]


# --------------------------------------------------------------------------
# Hàm chính (giữ nguyên chữ ký cũ để main.py không phải sửa)
# --------------------------------------------------------------------------
def synthesize_srt(
    srt_path: str,
    voice: str,
    enable_clone_save: bool,
    nameCloneSave: str,
    desCLoneSave: str,
    out_wav_path: str,
    ref_audio: str = None,
    ref_text: str = None,
    language: str = "vi",
    num_step: int = None,
    match_timing: bool = True,
    gap_padding_s: float = 0.05,
    instruct: str = None,
    voices_dir: str = None,
    genderCloneSave: str = None,
):
    """Tạo giọng cho cả file .srt/.vtt/.txt, ghi 1 file wav 24kHz.

    ref_text / language / num_step / instruct: model v3 Turbo không dùng,
    chỉ nhận vào cho tương thích. gap_padding_s chỉ dùng khi nguồn không có
    mốc giờ (vd .txt): khoảng im lặng giữa các câu; với .srt thì khoảng cách
    lấy từ chính mốc giờ trong file.
    """
    cues = _parse_source(srt_path)
    if not cues:
        raise ValueError("Không tìm thấy nội dung văn bản hợp lệ trong file nguồn.")
    voice_name = _resolve_voice(
        voice,
        ref_audio=ref_audio,
        enable_clone_save=enable_clone_save,
        nameCloneSave=nameCloneSave,
        desCLoneSave=desCLoneSave,
        voices_dir=voices_dir,
        genderCloneSave=genderCloneSave,
    )
    timed = all("start" in c and "end" in c for c in cues)
    out = bytearray()
    with tempfile.TemporaryDirectory(prefix="vera_cue_") as td:
        tmpdir = Path(td)
        if timed and match_timing:
            cursor = 0.0
            for cue in cues:
                text = cue["text"].strip()
                if not text:
                    continue
                start, end = cue["start"], cue["end"]
                slot = max(0.1, end - start)
                pcm = _speak(text, voice_name)
                if start > cursor:
                    out += _silence(start - cursor)
                    cursor = start
                out += _fit_cue(pcm, slot, tmpdir)
                cursor += slot
        else:
            # Không có mốc giờ (vd .txt) hoặc tắt khớp thời gian: nối tiếp nhau.
            first = True
            for cue in cues:
                text = cue["text"].strip()
                if not text:
                    continue
                if not first and gap_padding_s > 0:
                    out += _silence(gap_padding_s)
                out += _speak(text, voice_name)
                first = False
    _write_wav(out_wav_path, bytes(out))
    return out_wav_path


def synthesize(
    text: str,
    out_wav_path: str = "output.wav",
    ref_audio: str = None,
    ref_text: str = None,
    instruct: str = None,
    voice: str = None,
    voices_dir: str = None,
):
    """Tạo giọng cho 1 đoạn chữ (ref_text / instruct không dùng nữa)."""
    voice_name = _resolve_voice(
        voice or "Minh Đức",
        ref_audio=ref_audio,
        voices_dir=voices_dir,
    )
    pcm = _speak((text or "").strip(), voice_name)
    _write_wav(out_wav_path, pcm)
    return out_wav_path


def create_voice_profile(ref_audio: str, ref_text: str, output_file: str):
    """Đăng ký giọng clone theo tên file (stem của output_file), đồng thời giữ
    lại file mẫu cạnh output_file để đăng ký lại được khi server mất giọng."""
    name = Path(output_file).stem
    result = _enroll_voice(name, ref_audio, "")
    _save_clip_locally(Path(output_file).parent, name, ref_audio)
    return result
