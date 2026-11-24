import os
import requests
from pathlib import Path

API_BASE_URL = "http://127.0.0.1:8282"
TIMEOUT = 600  # giây - tổng hợp SRT dài có thể mất vài phút
SAMPLE_RATE = 24000  # phải khớp SAMPLE_RATE bên api_server.py/tts_core.py


def _download(download_url: str, out_path: str):
    full_url = f"{API_BASE_URL}{download_url}"
    r = requests.get(full_url, timeout=TIMEOUT, stream=True)
    r.raise_for_status()
    with open(out_path, "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)


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
):
    files = {"srt_file": open(srt_path, "rb")}
    if ref_audio:
        files["ref_audio"] = open(ref_audio, "rb")

    data = {
        "language": language,
        "match_timing": match_timing,
        "save_as_voice": enable_clone_save,
    }
    if voice:
        data["voice_id"] = voice
    if ref_text:
        data["ref_text"] = ref_text
    if num_step:
        data["num_step"] = num_step
    if instruct and str(instruct).strip():
        data["instruct"] = str(instruct).strip()
    if enable_clone_save:
        data["voice_name"] = nameCloneSave
        data["voice_description"] = desCLoneSave  
    try:
        resp = requests.post(
            f"{API_BASE_URL}/synthesize_srt",
            data=data,
            files=files,
            timeout=TIMEOUT,
            proxies={"http": None, "https": None},
        )
        resp.raise_for_status()
    finally:
        for f in files.values():
            f.close()

    result = resp.json()
    _download(result["download_url"], out_wav_path)
    return out_wav_path


def synthesize(
    text: str,
    out_wav_path: str = "output.wav",
    ref_audio: str = None,
    ref_text: str = None,
    instruct: str = None,
):
    files = {}
    if ref_audio:
        files["ref_audio"] = open(ref_audio, "rb")

    data = {"text": text}
    if ref_text:
        data["ref_text"] = ref_text
    if instruct and str(instruct).strip():
        data["instruct"] = str(instruct).strip()

    try:
        resp = requests.post(
            f"{API_BASE_URL}/synthesize",
            data=data,
            files=files,
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
    finally:
        for f in files.values():
            f.close()

    result = resp.json()
    _download(result["download_url"], out_wav_path)
    return out_wav_path


def create_voice_profile(ref_audio: str, ref_text: str, output_file: str):
    """Tạo voice clone trên server, lưu file .pt về máy local nếu cần."""
    with open(ref_audio, "rb") as f:
        resp = requests.post(
            f"{API_BASE_URL}/voice_profile",
            data={"ref_text": ref_text, "name": Path(output_file).stem},
            files={"ref_audio": f},
            timeout=TIMEOUT,
        )
    resp.raise_for_status()
    return resp.json()