"""Cấu hình nối Sub Studio ↔ Music TikTok. Không đụng folder_config / app_settings."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}

DEFAULTS = {
    "inbox": "",
    "ready": "",
    "posted": "",
    "failed": "",
    "copy_after_render": True,
    "download_auto_render": False,
    "music_from_ready": True,
    "move_after_post": True,
}


def _link_path(app_dir) -> Path:
    return Path(app_dir) / "config" / "workflow_link.json"


def get_shared_file(app_dir) -> str:
    p = _link_path(app_dir)
    if not p.is_file():
        return ""
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return str(data.get("file") or "").strip()
    except Exception:
        return ""


def set_shared_file(app_dir, file_path: str) -> str:
    path = str(file_path or "").strip()
    link = _link_path(app_dir)
    link.parent.mkdir(parents=True, exist_ok=True)
    link.write_text(
        json.dumps({"file": path}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return path


def load(app_dir) -> dict:
    out = dict(DEFAULTS)
    out["file"] = get_shared_file(app_dir)
    fp = out["file"]
    if fp and Path(fp).is_file():
        try:
            data = json.loads(Path(fp).read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for key in DEFAULTS:
                    if key in data:
                        out[key] = data[key]
        except Exception:
            pass
    return out


def save(app_dir, data: dict) -> dict:
    data = dict(data or {})
    file_path = str(data.get("file") or get_shared_file(app_dir) or "").strip()
    if not file_path:
        return {"ok": False, "error": "Chưa chọn file cấu hình chung."}
    payload = {}
    for key, default in DEFAULTS.items():
        val = data.get(key, default)
        if isinstance(default, bool):
            payload[key] = bool(val)
        else:
            payload[key] = str(val or "").strip()
    fp = Path(file_path)
    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    set_shared_file(app_dir, str(fp.resolve()))
    for key in ("inbox", "ready", "posted", "failed"):
        folder = payload.get(key) or ""
        if folder:
            Path(folder).mkdir(parents=True, exist_ok=True)
    return {"ok": True, "file": str(fp.resolve())}


def _count_videos(folder: str) -> int:
    p = Path(folder or "")
    if not p.is_dir():
        return 0
    n = 0
    try:
        for f in p.iterdir():
            if f.is_file() and f.suffix.lower() in VIDEO_EXTS:
                n += 1
    except Exception:
        return 0
    return n


def stats(app_dir) -> dict:
    wf = load(app_dir)
    return {
        "ready": _count_videos(wf.get("ready")),
        "posted": _count_videos(wf.get("posted")),
        "failed": _count_videos(wf.get("failed")),
        "inbox": _count_videos(wf.get("inbox")),
    }


def list_videos(folder: str) -> list[str]:
    p = Path(folder or "")
    out = []
    if not p.is_dir():
        return out
    try:
        for f in p.iterdir():
            if f.is_file() and f.suffix.lower() in VIDEO_EXTS:
                out.append(str(f.resolve()))
    except Exception:
        pass
    return out


def copy_to_ready(output_path, app_dir, enabled=None) -> str:
    wf = load(app_dir)
    if enabled is False:
        return ""
    if enabled is None and not wf.get("copy_after_render"):
        return ""
    ready = str(wf.get("ready") or "").strip()
    src = Path(str(output_path or ""))
    if not ready or not src.is_file():
        return ""
    dest_dir = Path(ready)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    if dest.resolve() == src.resolve():
        return str(dest)
    shutil.copy2(src, dest)
    return str(dest)


def relocate_after_post(video_path, ok: bool, app_dir) -> str:
    wf = load(app_dir)
    if not wf.get("move_after_post"):
        return ""
    src = Path(str(video_path or ""))
    if not src.is_file():
        return ""
    dest_dir = Path(str(wf.get("posted" if ok else "failed") or "").strip())
    if not str(dest_dir):
        return ""
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    if dest.resolve() == src.resolve():
        return str(dest)
    shutil.move(str(src), dest)
    return str(dest)
