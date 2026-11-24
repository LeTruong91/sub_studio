"""Cấu hình hàng đợi Facebook (Sheet + Drive). File riêng, không đụng WorkFlow TikTok."""

from __future__ import annotations

import json
from pathlib import Path
import threading
import time

import sheet_queue

DEFAULTS = {
    "enabled": False,
    "oauth_json": "",
    "folder_id": "",
    "spreadsheet_id": "",
    "sheet_name": "jobs",
    "worker_id": "studio",
}


def _cfg_path(app_dir) -> Path:
    return Path(app_dir) / "config" / "fb_queue.json"


def _log_path(app_dir) -> Path:
    return Path(app_dir) / "config" / "fb_queue_last.log"


_log_lock = threading.Lock()


def _write_log(app_dir, text: str):
    line = str(text or "").strip()
    if not line:
        return
    try:
        path = _log_path(app_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%H:%M:%S")
        with _log_lock:
            old = ""
            if path.is_file():
                old = path.read_text(encoding="utf-8")
            lines = [x for x in old.splitlines() if x.strip()][-40:]
            lines.append(stamp + " " + line)
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except Exception:
        pass


def last_log(app_dir) -> str:
    p = _log_path(app_dir)
    if not p.is_file():
        return ""
    try:
        return p.read_text(encoding="utf-8")
    except Exception:
        return ""


def load(app_dir) -> dict:
    out = dict(DEFAULTS)
    p = _cfg_path(app_dir)
    if p.is_file():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for key, default in DEFAULTS.items():
                    if key not in data:
                        continue
                    if isinstance(default, bool):
                        out[key] = bool(data[key])
                    else:
                        out[key] = str(data[key] or "").strip()
        except Exception:
            pass
    sid = str(out.get("spreadsheet_id") or "").strip()
    out["sheet_url"] = (
        f"https://docs.google.com/spreadsheets/d/{sid}/edit#gid=0" if sid else ""
    )
    out["last_log"] = last_log(app_dir)
    return out


def save(app_dir, data: dict) -> dict:
    payload = dict(DEFAULTS)
    data = dict(data or {})
    existing = load(app_dir)
    payload["enabled"] = bool(data.get("enabled"))
    for key in ("oauth_json", "folder_id", "spreadsheet_id", "sheet_name", "worker_id"):
        if key == "spreadsheet_id" and "spreadsheet_id" not in data:
            payload[key] = str(existing.get(key) or "").strip()
            continue
        payload[key] = str(data.get(key) or DEFAULTS[key] or "").strip()
    if not payload["sheet_name"]:
        payload["sheet_name"] = "jobs"
    if not payload["worker_id"]:
        payload["worker_id"] = "studio"
    path = _cfg_path(app_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "file": str(path)}


def _require(cfg: dict):
    oauth = Path(cfg.get("oauth_json") or "")
    if not oauth.is_file():
        raise RuntimeError("Chưa chọn file OAuth JSON.")
    if not str(cfg.get("folder_id") or "").strip():
        raise RuntimeError("Chưa điền ID folder Drive.")
    return oauth


def account_status(app_dir) -> dict:
    cfg = load(app_dir)
    return {"ok": bool(sheet_queue.account_ready(cfg.get("oauth_json")))}


def connect(app_dir) -> dict:
    cfg = load(app_dir)
    oauth = _require(cfg)
    sheet_queue.credentials(oauth)
    return {"ok": True, "token": str(sheet_queue.token_path_for(oauth))}


def init_sheet(app_dir) -> dict:
    cfg = load(app_dir)
    oauth = _require(cfg)
    drive, sheets = sheet_queue.services(oauth)
    sid = str(cfg.get("spreadsheet_id") or "").strip()
    folder = cfg["folder_id"]
    if not sid:
        sid = sheet_queue.create_spreadsheet(drive, sheets, folder)
        cfg["spreadsheet_id"] = sid
        save(app_dir, cfg)
    else:
        sheet_queue.ensure_headers(sheets, sid, cfg.get("sheet_name") or "jobs")
    return {"ok": True, "spreadsheet_id": sid}


def queue_stats(app_dir) -> dict:
    cfg = load(app_dir)
    if not str(cfg.get("spreadsheet_id") or "").strip():
        return {s: 0 for s in list(sheet_queue.STATUSES) + ["total"]}
    oauth = _require(cfg)
    _, sheets = sheet_queue.services(oauth)
    return sheet_queue.stats(sheets, cfg["spreadsheet_id"], cfg.get("sheet_name") or "jobs")


def enqueue_output(output_path, app_dir, enabled=None, on_progress=None, on_stage=None) -> dict:
    cfg = load(app_dir)
    want = cfg.get("enabled") if enabled is None else bool(enabled)
    if not want:
        _write_log(app_dir, "Bỏ qua: chưa bật Facebook ở Render.")
        return {"ok": False, "skipped": True}
    src = Path(str(output_path or ""))
    if not src.is_file():
        msg = f"Khong thay file render: {output_path}"
        _write_log(app_dir, msg)
        return {"ok": False, "error": msg}
    try:
        oauth = _require(cfg)
        sid = str(cfg.get("spreadsheet_id") or "").strip()
        if not sid:
            raise RuntimeError("Chưa có Spreadsheet ID. Bấm khởi tạo Sheet.")
        drive, sheets = sheet_queue.services(oauth)
        job = sheet_queue.enqueue(
            drive,
            sheets,
            cfg["folder_id"],
            sid,
            src,
            sheet_name=cfg.get("sheet_name") or "jobs",
            caption=src.stem,
            on_progress=on_progress,
            on_stage=on_stage,
        )
    except Exception as exc:
        _write_log(app_dir, str(exc))
        return {"ok": False, "error": str(exc)}
    _write_log(app_dir, f"OK job={job.get('id')} file={src.name}")
    job["sheet_url"] = f"https://docs.google.com/spreadsheets/d/{sid}/edit"
    return {"ok": True, **job}
