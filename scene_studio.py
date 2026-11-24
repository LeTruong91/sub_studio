"""Xưởng cảnh: lưu câu chuyện, ảnh tham chiếu, clip từng cảnh, ghép vào Ready."""

from __future__ import annotations

import json
import re
import threading
import uuid
from pathlib import Path

import pipeline_wf as workflow
from subprocess_utils import run_hidden
from video_utils import FFMPEG_EXE

_LOCK = threading.Lock()
_KINDS = {"character", "location", "prop"}
_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
_VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}


def _store_path(app_dir) -> Path:
    return Path(app_dir) / "scene_studio.json"


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _clean_id(value) -> str:
    text = re.sub(r"[^a-zA-Z0-9_-]", "", str(value or "").strip())[:40]
    return text or _new_id()


def _text(value, limit: int) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def _media_path(value, exts: set[str]) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    path = Path(raw)
    if path.suffix.lower() not in exts or not path.is_file():
        return ""
    return str(path)


def empty_state() -> dict:
    return {"story": "", "entities": [], "scenes": [], "output": "", "ready": ""}


def load_state(app_dir) -> dict:
    path = _store_path(app_dir)
    data = empty_state()
    if path.is_file():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            raw = {}
        if isinstance(raw, dict):
            data["story"] = _text(raw.get("story"), 4000)
            data["output"] = str(raw.get("output") or "")
            data["entities"] = _normalize_entities(raw.get("entities"), {})
            data["scenes"] = _normalize_scenes(raw.get("scenes"), {}, data["entities"])
    wf = workflow.load(app_dir)
    data["ready"] = str(wf.get("ready") or "").strip()
    return data


def _normalize_entities(rows, previous: dict) -> list[dict]:
    out = []
    seen = set()
    for row in list(rows or [])[:40]:
        if not isinstance(row, dict):
            continue
        item_id = _clean_id(row.get("id"))
        if item_id in seen:
            item_id = _new_id()
        seen.add(item_id)
        kind = str(row.get("kind") or "character").strip().lower()
        if kind not in _KINDS:
            kind = "character"
        name = _text(row.get("name"), 80)
        if not name:
            old = previous.get(item_id) or {}
            name = _text(old.get("name"), 80)
        if not name:
            continue
        out.append(
            {
                "id": item_id,
                "name": name,
                "kind": kind,
                "appearance": _text(row.get("appearance"), 500),
                "image": _media_path(row.get("image"), _IMAGE_EXT),
            }
        )
    return out


def _normalize_scenes(rows, previous: dict, entities: list[dict]) -> list[dict]:
    allowed = {item["id"] for item in entities}
    out = []
    seen = set()
    for row in list(rows or [])[:40]:
        if not isinstance(row, dict):
            continue
        item_id = _clean_id(row.get("id"))
        if item_id in seen:
            item_id = _new_id()
        seen.add(item_id)
        prev = previous.get(item_id) or {}
        image = _media_path(row.get("image"), _IMAGE_EXT)
        video = _media_path(row.get("video"), _VIDEO_EXT)
        if prev:
            used = 1 if prev.get("regen_used") else 0
            old_image = str(prev.get("image") or "")
            if old_image and image != old_image:
                if used:
                    image = old_image
                    video = _media_path(prev.get("video"), _VIDEO_EXT)
                else:
                    used = 1
                    video = ""
        else:
            used = 1 if row.get("regen_used") else 0
        ids = []
        for ref in row.get("entity_ids") or []:
            ref_id = _clean_id(ref)
            if ref_id in allowed and ref_id not in ids:
                ids.append(ref_id)
        out.append(
            {
                "id": item_id,
                "action": _text(row.get("action"), 500),
                "entity_ids": ids,
                "image": image,
                "video": video,
                "regen_used": used,
            }
        )
    return out


def save_state(app_dir, data) -> dict:
    with _LOCK:
        current = load_state(app_dir)
        prev_entities = {item["id"]: item for item in current.get("entities") or []}
        prev_scenes = {item["id"]: item for item in current.get("scenes") or []}
        incoming = data if isinstance(data, dict) else {}
        entities = _normalize_entities(incoming.get("entities"), prev_entities)
        scenes = _normalize_scenes(incoming.get("scenes"), prev_scenes, entities)
        saved = {
            "story": _text(incoming.get("story"), 4000),
            "entities": entities,
            "scenes": scenes,
            "output": str(current.get("output") or ""),
        }
        path = _store_path(app_dir)
        path.write_text(json.dumps(saved, ensure_ascii=False, indent=2), encoding="utf-8")
        saved["ready"] = current.get("ready") or ""
        return {"ok": True, "state": saved}


def _concat_line(path: Path) -> str:
    text = path.resolve().as_posix().replace("'", r"'\''")
    return "file '" + text + "'"


def _run_ffmpeg(cmd: list[str]) -> tuple[int, str]:
    result = run_hidden(cmd, capture_output=True)
    err = (result.stderr or b"").decode("utf-8", errors="replace")
    return int(result.returncode or 0), err[-1200:]


def export_ready(app_dir) -> dict:
    with _LOCK:
        state = load_state(app_dir)
        scenes = state.get("scenes") or []
        if not scenes:
            return {"ok": False, "error": "Chưa có cảnh."}
        missing = []
        paths = []
        for index, scene in enumerate(scenes, 1):
            video = Path(str(scene.get("video") or ""))
            if not video.is_file():
                missing.append(str(index))
            else:
                paths.append(video)
        if missing:
            return {"ok": False, "error": "Cảnh chưa có clip: " + ", ".join(missing)}
        ready = str(state.get("ready") or "").strip()
        if not ready:
            return {"ok": False, "error": "Chưa chọn thư mục Ready trong Cấu hình thư mục."}
        if not Path(FFMPEG_EXE).is_file():
            return {"ok": False, "error": "Không thấy ffmpeg."}
        out_dir = Path(app_dir) / "scene_studio"
        out_dir.mkdir(parents=True, exist_ok=True)
        list_path = out_dir / "concat.txt"
        list_path.write_text("\n".join(_concat_line(path) for path in paths), encoding="utf-8")
        stamp = uuid.uuid4().hex[:6]
        dest = out_dir / f"xuong_canh_{stamp}.mp4"
        base = [str(FFMPEG_EXE), "-y", "-f", "concat", "-safe", "0", "-i", str(list_path)]
        code, err = _run_ffmpeg(base + ["-c", "copy", "-movflags", "+faststart", str(dest)])
        if code != 0 or not dest.is_file():
            code, err = _run_ffmpeg(
                base
                + [
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-movflags",
                    "+faststart",
                    str(dest),
                ]
            )
        if code != 0 or not dest.is_file():
            code, err = _run_ffmpeg(
                base + ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", str(dest)]
            )
        if code != 0 or not dest.is_file():
            return {"ok": False, "error": err or "Ghép video thất bại."}
        copied = workflow.copy_to_ready(dest, app_dir, enabled=True)
        if not copied:
            return {"ok": False, "error": "Đã ghép nhưng không copy được vào Ready."}
        raw_path = _store_path(app_dir)
        try:
            raw = json.loads(raw_path.read_text(encoding="utf-8"))
        except Exception:
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        raw["output"] = copied
        raw_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
        state["output"] = copied
        return {"ok": True, "output": copied, "state": state}
