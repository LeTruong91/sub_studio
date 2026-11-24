"""Bảng điều khiển Flow Kit trong Sub Studio.

Agent FastAPI của Flow Kit chạy riêng ở cổng 8100. Tab này tạo project,
nhân vật, cảnh, rồi đẩy job GENERATE_* vào hàng đợi của agent. Extension
Chrome và tab flow.google.com đã đăng nhập là phần sinh thật. Module này
không tự vẽ ảnh.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
from pathlib import Path
from urllib.parse import unquote, urlparse

import requests

import pipeline_wf
from subprocess_utils import popen_hidden, run_hidden
from video_utils import FFMPEG_EXE

API_BASE = "http://127.0.0.1:8100"
_DEFAULT_AGENT = Path(r"D:\Downloads\flowkit-main\flowkit-main")
_LOCK = threading.Lock()
_PROC = None
_LOG_HANDLE = None
_UUID = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_KINDS = {
    "character": "character",
    "location": "location",
    "prop": "visual_asset",
}
_MATERIALS = (
    "realistic",
    "3d_pixar",
    "anime",
    "ghibli",
    "stop_motion",
    "minecraft",
    "oil_painting",
    "watercolor",
    "comic_book",
    "cyberpunk",
    "claymation",
    "lego",
    "retro_vhs",
)
_COMPOSITION = {
    "character": (
        "COMPOSITION: Full body shot from head to toe, standing upright and straight (not tilted or leaning). "
        "Centered in frame with balanced composition. Front-facing view, looking directly at camera. "
        "Neutral simple background that doesn't distract from the subject. "
        "Proper proportions and anatomy. Character perfectly vertical, not skewed or rotated."
    ),
    "location": (
        "COMPOSITION: Establishing shot showing the full environment. "
        "Balanced level composition with straight horizon. Clear focal point. "
        "Atmospheric and richly detailed. Show depth and spatial layout."
    ),
    "visual_asset": (
        "COMPOSITION: Clear detailed view showing the asset's complete form. "
        "Appropriate angle to showcase distinctive features and functional elements. "
        "Centered with proper scale reference. Neutral background. "
        "Show key details, materials, and surface textures."
    ),
}


class AgentError(Exception):
    def __init__(self, message, status=0):
        super().__init__(message)
        self.status = int(status or 0)


def _config_path(app_dir) -> Path:
    return Path(app_dir) / "flowkit_link.json"


def _slug(text: str) -> str:
    raw = str(text or "").replace("Đ", "D").replace("đ", "d")
    raw = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode("ascii")
    raw = re.sub(r"[^a-z0-9]+", "_", raw.lower())
    return re.sub(r"_+", "_", raw).strip("_")


def _blank():
    agent = str(_DEFAULT_AGENT) if (_DEFAULT_AGENT / "agent" / "main.py").is_file() else ""
    return {
        "agent_dir": agent,
        "flow_project_id": "",
        "project_id": "",
        "video_id": "",
        "name": "",
        "story": "",
        "material": "realistic",
        "language": "vi",
        "orientation": "VERTICAL",
        "entities": [],
        "scenes": [],
    }


def _entity(row):
    kind = str((row or {}).get("kind") or "character")
    if kind not in _KINDS:
        kind = "character"
    return {
        "id": str((row or {}).get("id") or "") or "en" + uuid.uuid4().hex[:8],
        "name": str((row or {}).get("name") or "").strip(),
        "kind": kind,
        "appearance": str((row or {}).get("appearance") or "").strip(),
        "character_id": str((row or {}).get("character_id") or "").strip(),
    }


def _scene(row):
    ids = []
    for item in (row or {}).get("entity_ids") or []:
        text = str(item or "").strip()
        if text and text not in ids:
            ids.append(text)
    return {
        "id": str((row or {}).get("id") or "") or "sc" + uuid.uuid4().hex[:8],
        "prompt": str((row or {}).get("prompt") or "").strip(),
        "entity_ids": ids,
        "scene_id": str((row or {}).get("scene_id") or "").strip(),
    }


def normalize(data):
    base = _blank()
    raw = data if isinstance(data, dict) else {}
    base["agent_dir"] = str(raw.get("agent_dir") or base["agent_dir"]).strip()
    pin = str(raw.get("flow_project_id") or "").strip()
    if pin and not _UUID.match(pin):
        raise AgentError("Flow project ID phải là UUID lấy từ flow.google.com.")
    base["flow_project_id"] = pin
    base["project_id"] = str(raw.get("project_id") or "").strip()
    base["video_id"] = str(raw.get("video_id") or "").strip()
    base["name"] = str(raw.get("name") or "").strip()
    base["story"] = str(raw.get("story") or "").strip()
    material = str(raw.get("material") or "realistic").strip()
    base["material"] = material if material in _MATERIALS else "realistic"
    language = str(raw.get("language") or "vi").strip().lower()
    base["language"] = language if language in ("vi", "en") else "vi"
    orient = str(raw.get("orientation") or "VERTICAL").strip().upper()
    base["orientation"] = orient if orient in ("VERTICAL", "HORIZONTAL") else "VERTICAL"
    entities = [_entity(row) for row in (raw.get("entities") or [])][:40]
    scenes = [_scene(row) for row in (raw.get("scenes") or [])][:40]
    known = {row["id"] for row in entities}
    for scene in scenes:
        scene["entity_ids"] = [item for item in scene["entity_ids"] if item in known]
    names = [row["name"].casefold() for row in entities if row["name"]]
    if len(names) != len(set(names)):
        raise AgentError("Tên tham chiếu bị trùng.")
    slugs = [_slug(row["name"]) for row in entities if row["name"]]
    if any(not item for item in slugs):
        raise AgentError("Tên tham chiếu cần có chữ hoặc số.")
    if len(slugs) != len(set(slugs)):
        raise AgentError("Hai tên tham chiếu ra cùng một mã. Đổi một tên.")
    base["entities"] = entities
    base["scenes"] = scenes
    return base


def load_draft(app_dir):
    path = _config_path(app_dir)
    if not path.is_file():
        return _blank()
    try:
        return normalize(json.loads(path.read_text(encoding="utf-8")))
    except AgentError:
        raise
    except Exception:
        return _blank()


def save_draft(app_dir, data):
    draft = normalize(data)
    path = _config_path(app_dir)
    path.write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "draft": draft}


def _write(app_dir, draft):
    _config_path(app_dir).write_text(
        json.dumps(draft, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _detail(response):
    try:
        data = response.json()
    except Exception:
        text = (response.text or "").strip()
        return text[:400] or f"HTTP {response.status_code}"
    detail = data.get("detail", data) if isinstance(data, dict) else data
    if isinstance(detail, list):
        parts = []
        for item in detail:
            if isinstance(item, dict):
                parts.append(str(item.get("msg") or item))
            else:
                parts.append(str(item))
        return "; ".join(parts)[:500]
    return str(detail)[:500]


def _http(method, path, body=None, timeout=30):
    try:
        response = requests.request(
            method,
            API_BASE + path,
            json=body,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise AgentError("Agent Flow Kit chưa chạy ở cổng 8100.") from exc
    if response.status_code >= 400:
        raise AgentError(_detail(response), response.status_code)
    if not response.content:
        return {}
    try:
        return response.json()
    except Exception as exc:
        raise AgentError("Agent trả về dữ liệu không đọc được.") from exc


def _health():
    try:
        data = _http("GET", "/health", timeout=2)
    except AgentError:
        return None
    return data if isinstance(data, dict) else None


def _python_cmd():
    if not getattr(sys, "frozen", False):
        return [sys.executable]
    for name in ("python", "python3"):
        found = shutil.which(name)
        if found:
            return [found]
    launcher = shutil.which("py")
    if launcher:
        return [launcher, "-3"]
    return []


def _log_tail(app_dir):
    path = Path(app_dir) / "flowkit_agent.log"
    if not path.is_file():
        return ""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""
    return text[-700:].strip()


def start_agent(app_dir):
    global _PROC, _LOG_HANDLE
    health = _health()
    if health and health.get("status") == "ok":
        return {
            "ok": True,
            "already": True,
            "extension_connected": bool(health.get("extension_connected")),
        }
    try:
        draft = load_draft(app_dir)
    except AgentError as exc:
        return {"ok": False, "error": str(exc)}
    agent = Path(draft["agent_dir"])
    if not (agent / "agent" / "main.py").is_file():
        return {"ok": False, "error": "Chọn đúng thư mục Flow Kit, thư mục có agent\\main.py."}
    command = _python_cmd()
    if not command:
        return {"ok": False, "error": "Không thấy Python để chạy agent Flow Kit."}
    with _LOCK:
        if _PROC is not None and _PROC.poll() is None:
            return {"ok": False, "error": "Agent vừa được mở nhưng cổng 8100 chưa trả lời."}
        log_path = Path(app_dir) / "flowkit_agent.log"
        handle = open(log_path, "a", encoding="utf-8")
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        if draft["flow_project_id"]:
            env["FLOW_PROJECT_ID"] = draft["flow_project_id"]
        else:
            env.pop("FLOW_PROJECT_ID", None)
        try:
            proc = popen_hidden(
                command + ["-m", "agent.main"],
                cwd=str(agent),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=handle,
                stderr=subprocess.STDOUT,
            )
        except Exception as exc:
            handle.close()
            return {"ok": False, "error": str(exc)}
        _PROC = proc
        _LOG_HANDLE = handle
    for _ in range(40):
        if proc.poll() is not None:
            tail = _log_tail(app_dir)
            return {"ok": False, "error": tail or "Agent Flow Kit tắt ngay sau khi mở."}
        health = _health()
        if health and health.get("status") == "ok":
            return {
                "ok": True,
                "already": False,
                "extension_connected": bool(health.get("extension_connected")),
            }
        time.sleep(0.5)
    return {"ok": False, "error": "Agent chưa mở cổng 8100. Xem flowkit_agent.log."}


def _ready_text(app_dir):
    try:
        return str(pipeline_wf.load(app_dir).get("ready") or "").strip()
    except Exception:
        return ""


def _prefix(orientation):
    return "vertical" if orientation == "VERTICAL" else "horizontal"


def _latest_request(rows, **match):
    found = None
    for row in rows or []:
        if any(str(row.get(key) or "") != value for key, value in match.items()):
            continue
        if found is None or str(row.get("updated_at") or "") >= str(found.get("updated_at") or ""):
            found = row
    return found


def _chip(remote_status, request):
    active = request if request and request.get("status") in ("PENDING", "PROCESSING") else None
    if active:
        return ("Đang chờ" if active.get("status") == "PENDING" else "Đang sinh", "")
    if remote_status == "COMPLETED":
        return ("Xong", "")
    if request and request.get("status") == "FAILED":
        return ("Lỗi", str(request.get("error_message") or ""))
    if remote_status == "FAILED":
        return ("Lỗi", "")
    return ("Chưa sinh", "")


def status(app_dir):
    try:
        draft = load_draft(app_dir)
    except AgentError as exc:
        return {"ok": False, "error": str(exc)}
    health = _health()
    result = {
        "ok": True,
        "agent_running": bool(health and health.get("status") == "ok"),
        "extension_connected": bool(health and health.get("extension_connected")),
        "project_id": draft["project_id"],
        "video_id": draft["video_id"],
        "ready": _ready_text(app_dir),
        "entities": {},
        "scenes": {},
        "jobs": {"pending": 0, "processing": 0, "failed": 0, "completed": 0},
    }
    if not result["agent_running"] or not draft["project_id"]:
        return result
    try:
        characters = _http("GET", f"/api/projects/{draft['project_id']}/characters", timeout=8)
        scenes = []
        if draft["video_id"]:
            scenes = _http("GET", f"/api/scenes?video_id={draft['video_id']}", timeout=8)
        requests_rows = _http("GET", f"/api/requests?project_id={draft['project_id']}", timeout=8)
    except AgentError as exc:
        result["error"] = str(exc)
        return result
    if not isinstance(characters, list):
        characters = []
    if not isinstance(scenes, list):
        scenes = []
    if not isinstance(requests_rows, list):
        requests_rows = []
    for row in requests_rows:
        key = str(row.get("status") or "").lower()
        if key in result["jobs"]:
            result["jobs"][key] += 1
    by_char = {str(row.get("id") or ""): row for row in characters}
    by_scene = {str(row.get("id") or ""): row for row in scenes}
    prefix = _prefix(draft["orientation"])
    for entity in draft["entities"]:
        remote = by_char.get(entity["character_id"]) or {}
        request = _latest_request(
            requests_rows,
            character_id=entity["character_id"],
        ) if entity["character_id"] else None
        text, error = _chip("COMPLETED" if remote.get("media_id") else "", request)
        result["entities"][entity["id"]] = {
            "text": text,
            "error": error,
            "image_url": str(remote.get("reference_image_url") or ""),
        }
    for scene in draft["scenes"]:
        remote = by_scene.get(scene["scene_id"]) or {}
        image_req = _latest_request(requests_rows, scene_id=scene["scene_id"], type="GENERATE_IMAGE")
        image_regen = _latest_request(requests_rows, scene_id=scene["scene_id"], type="REGENERATE_IMAGE")
        if image_regen and (not image_req or str(image_regen.get("updated_at") or "") >= str(image_req.get("updated_at") or "")):
            image_req = image_regen
        video_req = _latest_request(requests_rows, scene_id=scene["scene_id"], type="GENERATE_VIDEO")
        video_regen = _latest_request(requests_rows, scene_id=scene["scene_id"], type="REGENERATE_VIDEO")
        if video_regen and (not video_req or str(video_regen.get("updated_at") or "") >= str(video_req.get("updated_at") or "")):
            video_req = video_regen
        image_text, image_error = _chip(str(remote.get(f"{prefix}_image_status") or ""), image_req)
        video_text, video_error = _chip(str(remote.get(f"{prefix}_video_status") or ""), video_req)
        result["scenes"][scene["id"]] = {
            "image": image_text,
            "video": video_text,
            "image_error": image_error,
            "video_error": video_error,
            "image_url": str(remote.get(f"{prefix}_image_url") or ""),
            "video_url": str(remote.get(f"{prefix}_video_url") or ""),
        }
    return result


def snapshot(app_dir):
    try:
        draft = load_draft(app_dir)
    except AgentError as exc:
        return {"ok": False, "error": str(exc)}
    live = status(app_dir)
    live["draft"] = draft
    return live


def _material(material_id):
    data = _http("GET", f"/api/materials/{material_id}", timeout=8)
    return data if isinstance(data, dict) else {}


def _reference_prompt(name, appearance, story, entity_type, material):
    base = appearance or name
    composition = _COMPOSITION.get(entity_type, _COMPOSITION["character"])
    style = str(material.get("style_instruction") or "").strip()
    negative = str(material.get("negative_prompt") or "").strip()
    if negative:
        style = (style + " " + negative).strip()
    lighting = str(material.get("lighting") or "Studio lighting, highly detailed")
    if story:
        prefix = f"Single reference image of {base}. "
        single = "ONE single image only, NOT a multi-panel grid or multiple views. "
    else:
        prefix = f"Reference image of {base}. "
        single = ""
    return (
        f"{prefix}{style} {composition} {single}{lighting}"
    ).strip()


def _scene_prompt(user_prompt, material):
    prefix = str(material.get("scene_prefix") or "").strip()
    text = str(user_prompt or "").strip()
    if prefix and not text.startswith(prefix):
        return f"{prefix} {text}"
    return text


def _match_characters(draft, remote_rows):
    by_name = {}
    for row in remote_rows or []:
        by_name.setdefault(str(row.get("name") or "").casefold(), row)
    for entity in draft["entities"]:
        if entity["character_id"]:
            continue
        found = by_name.get(entity["name"].casefold())
        if found:
            entity["character_id"] = str(found.get("id") or "")


def sync(app_dir, data):
    try:
        draft = normalize(data)
    except AgentError as exc:
        return {"ok": False, "error": str(exc)}
    if not draft["name"]:
        return {"ok": False, "error": "Nhập tên project."}
    if not draft["entities"]:
        return {"ok": False, "error": "Thêm ít nhất một ảnh tham chiếu."}
    if any(not row["name"] for row in draft["entities"]):
        return {"ok": False, "error": "Mỗi tham chiếu cần có tên."}
    if not draft["scenes"]:
        return {"ok": False, "error": "Thêm ít nhất một cảnh."}
    empty = [str(index) for index, row in enumerate(draft["scenes"], 1) if not row["prompt"]]
    if empty:
        return {"ok": False, "error": "Cảnh chưa có hành động: " + ", ".join(empty)}
    if not _health():
        return {"ok": False, "error": "Hãy khởi động agent Flow Kit trước."}
    names = {row["id"]: row["name"] for row in draft["entities"]}
    try:
        material = _material(draft["material"])
        if not draft["project_id"]:
            health = _health() or {}
            if not draft["flow_project_id"] and not health.get("extension_connected"):
                return {
                    "ok": False,
                    "error": "Extension chưa nối. Mở flow.google.com đã đăng nhập và bật extension, hoặc dán Flow project ID.",
                }
            draft["video_id"] = ""
            for entity in draft["entities"]:
                entity["character_id"] = ""
            for scene in draft["scenes"]:
                scene["scene_id"] = ""
            body = {
                "name": draft["name"],
                "story": draft["story"],
                "language": draft["language"],
                "material": draft["material"],
                "characters": [
                    {
                        "name": row["name"],
                        "entity_type": _KINDS[row["kind"]],
                        "description": row["appearance"] or row["name"],
                    }
                    for row in draft["entities"]
                ],
            }
            if draft["flow_project_id"]:
                body["flow_project_id"] = draft["flow_project_id"]
            created = _http("POST", "/api/projects", body, timeout=90)
            draft["project_id"] = str(created.get("id") or "")
            if not draft["project_id"]:
                return {"ok": False, "error": "Agent không trả về project."}
            _write(app_dir, draft)
            remote = _http("GET", f"/api/projects/{draft['project_id']}/characters")
            _match_characters(draft, remote if isinstance(remote, list) else [])
            _write(app_dir, draft)
        else:
            _http(
                "PATCH",
                f"/api/projects/{draft['project_id']}",
                {
                    "name": draft["name"],
                    "story": draft["story"],
                    "language": draft["language"],
                    "material": draft["material"],
                },
            )
        remote = _http("GET", f"/api/projects/{draft['project_id']}/characters")
        remote_rows = remote if isinstance(remote, list) else []
        _match_characters(draft, remote_rows)
        known = {str(row.get("id") or "") for row in remote_rows}
        for entity in draft["entities"]:
            entity_type = _KINDS[entity["kind"]]
            prompt = _reference_prompt(
                entity["name"],
                entity["appearance"],
                draft["story"],
                entity_type,
                material,
            )
            appearance = entity["appearance"] or entity["name"]
            if draft["story"]:
                description = f"{entity['name']}: {appearance}. Story context: {draft['story']}"
            else:
                description = appearance
            profile = {
                "name": entity["name"],
                "entity_type": entity_type,
                "description": description,
                "image_prompt": prompt,
            }
            if entity["character_id"] and entity["character_id"] in known:
                _http("PATCH", f"/api/characters/{entity['character_id']}", profile)
                continue
            created = _http("POST", "/api/characters", profile)
            entity["character_id"] = str(created.get("id") or "")
            _http(
                "POST",
                f"/api/projects/{draft['project_id']}/characters/{entity['character_id']}",
            )
        _write(app_dir, draft)
        if not draft["video_id"]:
            video = _http(
                "POST",
                "/api/videos",
                {
                    "project_id": draft["project_id"],
                    "title": draft["name"],
                    "orientation": draft["orientation"],
                },
            )
            draft["video_id"] = str(video.get("id") or "")
            if not draft["video_id"]:
                return {"ok": False, "error": "Agent không trả về video."}
            _write(app_dir, draft)
        else:
            _http(
                "PATCH",
                f"/api/videos/{draft['video_id']}",
                {"title": draft["name"], "orientation": draft["orientation"]},
            )
        for index, scene in enumerate(draft["scenes"]):
            payload = {
                "prompt": _scene_prompt(scene["prompt"], material),
                "character_names": [names[item] for item in scene["entity_ids"] if names.get(item)],
                "display_order": index,
                "chain_type": "ROOT",
            }
            if scene["scene_id"]:
                _http("PATCH", f"/api/scenes/{scene['scene_id']}", payload)
            else:
                created = _http(
                    "POST",
                    "/api/scenes",
                    {"video_id": draft["video_id"], **payload},
                )
                scene["scene_id"] = str(created.get("id") or "")
        _write(app_dir, draft)
    except AgentError as exc:
        _write(app_dir, draft)
        if exc.status == 502 and "extension" not in str(exc).lower() and not draft["flow_project_id"]:
            return {
                "ok": False,
                "error": "Chưa nối được Flow. Mở flow.google.com đã đăng nhập, bật extension, hoặc dán Flow project ID.",
            }
        return {"ok": False, "error": str(exc)}
    live = status(app_dir)
    live["draft"] = draft
    live["ok"] = True
    return live


def forget_remote(app_dir):
    try:
        draft = load_draft(app_dir)
    except AgentError as exc:
        return {"ok": False, "error": str(exc)}
    draft["project_id"] = ""
    draft["video_id"] = ""
    for entity in draft["entities"]:
        entity["character_id"] = ""
    for scene in draft["scenes"]:
        scene["scene_id"] = ""
    _write(app_dir, draft)
    return snapshot(app_dir)


def remove_remote(app_dir, kind, remote_id):
    remote_id = str(remote_id or "").strip()
    if not remote_id:
        return {"ok": True}
    if not _health():
        return {"ok": False, "error": "Agent chưa chạy nên chưa xóa trên Flow Kit."}
    try:
        draft = load_draft(app_dir)
        if kind == "character":
            if draft["project_id"]:
                try:
                    _http("DELETE", f"/api/projects/{draft['project_id']}/characters/{remote_id}")
                except AgentError as exc:
                    if exc.status != 404:
                        raise
            _http("DELETE", f"/api/characters/{remote_id}")
        elif kind == "scene":
            _http("DELETE", f"/api/scenes/{remote_id}")
        else:
            return {"ok": False, "error": "Không xóa được mục này."}
    except AgentError as exc:
        if exc.status == 404:
            return {"ok": True}
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


def _queue(body):
    try:
        _http("POST", "/api/requests", body)
    except AgentError as exc:
        if exc.status != 409:
            raise
    return True


def enqueue(app_dir, stage):
    stage = str(stage or "")
    if stage not in ("refs", "images", "videos"):
        return {"ok": False, "error": "Bước sinh không hợp lệ."}
    try:
        draft = load_draft(app_dir)
    except AgentError as exc:
        return {"ok": False, "error": str(exc)}
    if not draft["project_id"] or not draft["video_id"]:
        return {"ok": False, "error": "Bấm Đồng bộ sang Flow Kit trước khi sinh."}
    if not _health():
        return {"ok": False, "error": "Agent Flow Kit chưa chạy."}
    live = status(app_dir)
    if live.get("error"):
        return {"ok": False, "error": live["error"]}
    if not live.get("extension_connected"):
        return {"ok": False, "error": "Extension chưa nối. Mở flow.google.com đã đăng nhập và bật extension Flow Kit."}
    queued = 0
    notes = []
    try:
        if stage == "refs":
            for entity in draft["entities"]:
                chip = (live.get("entities") or {}).get(entity["id"]) or {}
                if chip.get("text") in ("Xong", "Đang sinh", "Đang chờ"):
                    continue
                if not entity["character_id"]:
                    notes.append(entity["name"] or "tham chiếu")
                    continue
                _queue({
                    "type": "GENERATE_CHARACTER_IMAGE",
                    "project_id": draft["project_id"],
                    "character_id": entity["character_id"],
                })
                queued += 1
        else:
            req_type = "GENERATE_IMAGE" if stage == "images" else "GENERATE_VIDEO"
            field = "image" if stage == "images" else "video"
            for index, scene in enumerate(draft["scenes"], 1):
                chip = (live.get("scenes") or {}).get(scene["id"]) or {}
                if chip.get(field) in ("Xong", "Đang sinh", "Đang chờ"):
                    continue
                if stage == "images":
                    missing = []
                    for entity_id in scene["entity_ids"]:
                        entity = next((row for row in draft["entities"] if row["id"] == entity_id), None)
                        ent = (live.get("entities") or {}).get(entity_id) or {}
                        if entity and ent.get("text") != "Xong":
                            missing.append(entity["name"] or "tham chiếu")
                    if missing:
                        notes.append(f"Cảnh {index} chờ ảnh tham chiếu: {', '.join(missing)}")
                        continue
                elif chip.get("image") != "Xong":
                    notes.append(f"Cảnh {index} chưa có ảnh")
                    continue
                if not scene["scene_id"]:
                    notes.append(f"Cảnh {index} chưa đồng bộ")
                    continue
                _queue({
                    "type": req_type,
                    "project_id": draft["project_id"],
                    "video_id": draft["video_id"],
                    "scene_id": scene["scene_id"],
                    "orientation": draft["orientation"],
                })
                queued += 1
    except AgentError as exc:
        return {"ok": False, "error": str(exc), "queued": queued}
    live = status(app_dir)
    live["ok"] = True
    live["queued"] = queued
    live["notes"] = notes
    return live


def regen(app_dir, kind, local_id):
    kind = str(kind or "")
    local_id = str(local_id or "")
    try:
        draft = load_draft(app_dir)
    except AgentError as exc:
        return {"ok": False, "error": str(exc)}
    if not _health():
        return {"ok": False, "error": "Agent Flow Kit chưa chạy."}
    live = status(app_dir)
    if live.get("error"):
        return {"ok": False, "error": live["error"]}
    if not live.get("extension_connected"):
        return {"ok": False, "error": "Extension chưa nối."}
    try:
        if kind == "character":
            entity = next((row for row in draft["entities"] if row["id"] == local_id), None)
            if not entity or not entity["character_id"]:
                return {"ok": False, "error": "Tham chiếu này chưa đồng bộ."}
            chip = (live.get("entities") or {}).get(local_id) or {}
            req_type = "REGENERATE_CHARACTER_IMAGE" if chip.get("text") == "Xong" else "GENERATE_CHARACTER_IMAGE"
            _queue({
                "type": req_type,
                "project_id": draft["project_id"],
                "character_id": entity["character_id"],
            })
        elif kind in ("image", "video"):
            scene = next((row for row in draft["scenes"] if row["id"] == local_id), None)
            if not scene or not scene["scene_id"]:
                return {"ok": False, "error": "Cảnh này chưa đồng bộ."}
            chip = (live.get("scenes") or {}).get(local_id) or {}
            if kind == "video" and chip.get("image") != "Xong":
                return {"ok": False, "error": "Sinh ảnh cảnh trước khi tạo lại clip."}
            if kind == "image":
                req_type = "REGENERATE_IMAGE" if chip.get("image") == "Xong" else "GENERATE_IMAGE"
            else:
                req_type = "REGENERATE_VIDEO" if chip.get("video") == "Xong" else "GENERATE_VIDEO"
            _queue({
                "type": req_type,
                "project_id": draft["project_id"],
                "video_id": draft["video_id"],
                "scene_id": scene["scene_id"],
                "orientation": draft["orientation"],
            })
        else:
            return {"ok": False, "error": "Không tạo lại được mục này."}
    except AgentError as exc:
        return {"ok": False, "error": str(exc)}
    return status(app_dir)


def _local_media(url, dest: Path):
    text = str(url or "").strip()
    if not text:
        return None
    parsed = urlparse(text)
    if parsed.scheme == "file":
        path = unquote(parsed.path)
        if os.name == "nt" and path.startswith("/") and len(path) > 2 and path[2] == ":":
            path = path[1:]
        candidate = Path(path)
        return candidate if candidate.is_file() else None
    if parsed.scheme in ("http", "https"):
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            response = requests.get(text, timeout=120)
            response.raise_for_status()
        except requests.RequestException:
            return None
        dest.write_bytes(response.content)
        return dest if dest.is_file() and dest.stat().st_size > 0 else None
    candidate = Path(text)
    return candidate if candidate.is_file() else None


def _concat_line(path: Path) -> str:
    text = path.resolve().as_posix().replace("'", r"'\''")
    return "file '" + text + "'"


def _ffmpeg(cmd):
    result = run_hidden(cmd, capture_output=True)
    err = (result.stderr or b"").decode("utf-8", errors="replace")
    return int(result.returncode or 0), err[-800:]


def export_ready(app_dir):
    try:
        draft = load_draft(app_dir)
    except AgentError as exc:
        return {"ok": False, "error": str(exc)}
    if not draft["scenes"]:
        return {"ok": False, "error": "Chưa có cảnh."}
    ready = _ready_text(app_dir)
    if not ready:
        return {"ok": False, "error": "Chưa chọn thư mục Ready trong Cấu hình thư mục."}
    if not Path(FFMPEG_EXE).is_file():
        return {"ok": False, "error": "Không thấy ffmpeg."}
    live = status(app_dir)
    if not live.get("agent_running"):
        return {"ok": False, "error": "Agent Flow Kit chưa chạy nên chưa lấy được clip."}
    missing = []
    paths = []
    out_dir = Path(app_dir) / "flowkit_export"
    out_dir.mkdir(parents=True, exist_ok=True)
    for index, scene in enumerate(draft["scenes"], 1):
        chip = (live.get("scenes") or {}).get(scene["id"]) or {}
        if chip.get("video") != "Xong":
            missing.append(str(index))
            continue
        part = out_dir / f"part_{index}.mp4"
        local = _local_media(chip.get("video_url"), part)
        if local is None:
            missing.append(str(index))
        else:
            paths.append(local)
    if missing:
        return {"ok": False, "error": "Cảnh chưa có clip: " + ", ".join(missing)}
    list_path = out_dir / "concat.txt"
    list_path.write_text("\n".join(_concat_line(path) for path in paths), encoding="utf-8")
    dest = out_dir / f"xuong_canh_{uuid.uuid4().hex[:6]}.mp4"
    base = [str(FFMPEG_EXE), "-y", "-f", "concat", "-safe", "0", "-i", str(list_path)]
    code, err = _ffmpeg(base + ["-c", "copy", "-movflags", "+faststart", str(dest)])
    if code != 0 or not dest.is_file():
        code, err = _ffmpeg(base + ["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", str(dest)])
    if code != 0 or not dest.is_file():
        return {"ok": False, "error": err or "Không ghép được clip."}
    copied = pipeline_wf.copy_to_ready(dest, app_dir, enabled=True)
    if not copied:
        return {"ok": False, "error": "Ghép xong nhưng chưa copy vào Ready."}
    return {"ok": True, "path": copied}
