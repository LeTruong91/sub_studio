"""Lưu thông tin video lên Google Sheet và upload file render lên Drive.

Tách khỏi hàng đợi Facebook. Không đổi cấu hình Render Studio.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from pathlib import Path

import sheet_queue

DEFAULTS = {
    "enabled": False,
    "download_auto_render": False,
    "render_crop": True,
    "render_random_cut": False,
    "render_color": False,
    "render_volume": False,
    "render_combo_a": False,
    "render_highlight": False,
    "render_two_screen": False,
    "highlight_volume": False,
    "highlight_score": 0.5,
    "highlight_seconds": 60,
    "oauth_json": "",
    "folder_id": "",
    "spreadsheet_id": "",
    "sheet_name": "data",
}

HEADERS = [
    "id",
    "created_at",
    "video_name",
    "channel",
    "drive_url",
    "status",
    "timepost",
    "note",
]

_CHANNEL_RE = re.compile(r"^[A-Za-z0-9_-]{8,}$")
_SKIP_FOLDERS = {
    "rendefinal",
    "download",
    "downloads",
    "download_video",
    "inbox",
    "ready",
    "posted",
    "failed",
    "output",
    "outputs",
    "video",
    "videos",
    "music",
    "channels",
}
_log_lock = threading.Lock()
_files_lock = threading.Lock()


def _cfg_path(app_dir) -> Path:
    return Path(app_dir) / "config" / "data_queue.json"


def _log_path(app_dir) -> Path:
    return Path(app_dir) / "config" / "data_queue_last.log"


def _files_path(app_dir) -> Path:
    return Path(app_dir) / "config" / "data_queue_files.json"


def _load_files(app_dir) -> dict:
    path = _files_path(app_dir)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_file_row(app_dir, row_id: str, output_path="", source_path="", drive_file_id="") -> None:
    row_id = str(row_id or "").strip()
    if not row_id:
        return
    with _files_lock:
        data = _load_files(app_dir)
        prev = data.get(row_id) if isinstance(data.get(row_id), dict) else {}
        data[row_id] = {
            "output_path": str(output_path or prev.get("output_path") or ""),
            "source_path": str(source_path or prev.get("source_path") or ""),
            "drive_file_id": str(drive_file_id or prev.get("drive_file_id") or ""),
        }
        path = _files_path(app_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _file_row(app_dir, row_id: str) -> dict:
    rec = _load_files(app_dir).get(str(row_id or "").strip())
    return rec if isinstance(rec, dict) else {}


def _write_log(app_dir, text: str):
    line = str(text or "").strip()
    if not line:
        return
    try:
        path = _log_path(app_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%H:%M:%S")
        with _log_lock:
            old = path.read_text(encoding="utf-8") if path.is_file() else ""
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
                    elif isinstance(default, float):
                        try:
                            out[key] = float(data[key])
                        except (TypeError, ValueError):
                            out[key] = default
                    elif isinstance(default, int):
                        try:
                            out[key] = int(data[key])
                        except (TypeError, ValueError):
                            out[key] = default
                    else:
                        out[key] = str(data[key] or "").strip()
        except Exception:
            pass
    if not out["sheet_name"]:
        out["sheet_name"] = "data"
    sid = str(out.get("spreadsheet_id") or "").strip()
    out["sheet_url"] = (
        f"https://docs.google.com/spreadsheets/d/{sid}/edit#gid=0" if sid else ""
    )
    out["last_log"] = last_log(app_dir)
    return out


def save(app_dir, data: dict) -> dict:
    payload = dict(DEFAULTS)
    data = dict(data or {})
    payload["enabled"] = bool(data.get("enabled"))
    payload["download_auto_render"] = bool(data.get("download_auto_render"))
    payload["render_crop"] = bool(data.get("render_crop", True))
    payload["render_random_cut"] = bool(data.get("render_random_cut"))
    payload["render_color"] = bool(data.get("render_color"))
    payload["render_volume"] = bool(data.get("render_volume"))
    payload["render_combo_a"] = bool(data.get("render_combo_a"))
    payload["render_highlight"] = bool(data.get("render_highlight"))
    payload["render_two_screen"] = bool(data.get("render_two_screen"))
    payload["highlight_volume"] = bool(data.get("highlight_volume"))
    try:
        score = float(data.get("highlight_score"))
    except (TypeError, ValueError):
        score = 0.5
    payload["highlight_score"] = max(0.1, min(1.0, int(score * 10 + 0.5) / 10))
    try:
        seconds = int(data.get("highlight_seconds") or 60)
    except (TypeError, ValueError):
        seconds = 60
    payload["highlight_seconds"] = max(1, min(600, seconds))
    existing = load(app_dir)
    for key in ("oauth_json", "folder_id", "spreadsheet_id", "sheet_name"):
        if key == "spreadsheet_id" and "spreadsheet_id" in data:
            payload[key] = str(data.get(key) or "").strip()
            continue
        incoming = str(data.get(key) or "").strip()
        if not incoming and key != "sheet_name":
            incoming = str(existing.get(key) or "").strip()
        payload[key] = incoming or str(DEFAULTS[key] or "").strip()
    if not payload["sheet_name"]:
        payload["sheet_name"] = "data"
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


def channel_from_path(path) -> str:
    """Chỉ lấy thư mục chứa file. Không lấy thư mục cha phía trên."""
    name = Path(str(path or "")).parent.name.strip()
    if not name or name.lower() in _SKIP_FOLDERS:
        return ""
    if _CHANNEL_RE.match(name):
        return name
    return ""


def fill_empty_channels(app_dir) -> dict:
    """Điền cột channel còn trống từ thư mục kênh trong source_path / output_path."""
    try:
        sheets, sid, title = _open_data_sheet(app_dir)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    def _do():
        rows = _data_rows(sheets, sid, title)
        if not rows:
            return {"ok": True, "filled": 0}
        col = chr(ord("A") + HEADERS.index("channel"))
        values = []
        filled = 0
        for rec in rows:
            channel = str(rec.get("channel") or "").strip()
            if not channel:
                channel = channel_from_path(rec.get("source_path")) or channel_from_path(
                    rec.get("output_path")
                )
                if channel:
                    filled += 1
            values.append([channel])
        if filled:
            end = 1 + len(values)
            sheet_queue._retry(
                lambda: sheets.spreadsheets()
                .values()
                .update(
                    spreadsheetId=sid,
                    range=sheet_queue._a1(title, f"{col}2", f"{col}{end}"),
                    valueInputOption="RAW",
                    body={"values": values},
                )
                .execute()
            )
        return {"ok": True, "filled": filled, "rows": len(rows)}

    got = sheet_queue._with_sheet_lock(sheets, sid, title, _do)
    if not got:
        return {"ok": False, "error": "Sheet đang bận, thử lại."}
    return got


def account_status(app_dir) -> dict:
    cfg = load(app_dir)
    return {"ok": bool(sheet_queue.account_ready(cfg.get("oauth_json")))}


def connect(app_dir) -> dict:
    cfg = load(app_dir)
    oauth = _require(cfg)
    sheet_queue.credentials(oauth)
    return {"ok": True, "token": str(sheet_queue.token_path_for(oauth))}


def _sheet_table(sheets, spreadsheet_id: str, title: str):
    return (
        sheet_queue._retry(
            lambda: sheets.spreadsheets()
            .values()
            .get(
                spreadsheetId=spreadsheet_id,
                range=sheet_queue._a1(title, "A1", "I"),
            )
            .execute()
        ).get("values")
        or []
    )


def _header_names(row) -> list[str]:
    names = [str(x or "").strip() for x in (row or [])]
    while names and not names[-1]:
        names.pop()
    return names


def _cell_at(raw, index: dict, key: str) -> str:
    pos = index.get(key)
    if pos is None or pos >= len(raw or []):
        return ""
    return str(raw[pos] or "").strip()


def _rewrite_sheet(sheets, spreadsheet_id: str, title: str, table, header, app_dir) -> None:
    index = {name: i for i, name in enumerate(header) if name}
    new_rows = []
    for raw in table[1:]:
        row_id = _cell_at(raw, index, "id")
        video_name = _cell_at(raw, index, "video_name")
        if not row_id and not video_name:
            continue
        source_path = _cell_at(raw, index, "source_path")
        output_path = _cell_at(raw, index, "output_path")
        drive_file_id = _cell_at(raw, index, "drive_file_id")
        channel = _cell_at(raw, index, "channel")
        if not channel:
            channel = channel_from_path(source_path) or channel_from_path(output_path)
        status = _cell_at(raw, index, "status") or "pending"
        if app_dir and row_id:
            _save_file_row(app_dir, row_id, output_path, source_path, drive_file_id)
        new_rows.append([
            row_id,
            _cell_at(raw, index, "created_at"),
            video_name,
            channel,
            _cell_at(raw, index, "drive_url"),
            status,
            _cell_at(raw, index, "timepost"),
            _cell_at(raw, index, "note"),
        ])
    last = max(len(table), 1 + len(new_rows), 1)
    sheet_queue._retry(
        lambda: sheets.spreadsheets()
        .values()
        .clear(
            spreadsheetId=spreadsheet_id,
            range=sheet_queue._a1(title, "A1", f"I{last}"),
        )
        .execute()
    )
    values = [list(HEADERS)] + new_rows
    end_col = chr(ord("A") + len(HEADERS) - 1)
    sheet_queue._retry(
        lambda: sheets.spreadsheets()
        .values()
        .update(
            spreadsheetId=spreadsheet_id,
            range=sheet_queue._a1(title, "A1", f"{end_col}{len(values)}"),
            valueInputOption="RAW",
            body={"values": values},
        )
        .execute()
    )


def _ensure_sheet(sheets, spreadsheet_id: str, sheet_name: str, app_dir=None) -> str:
    name = str(sheet_name or "data").strip() or "data"
    meta = sheet_queue._retry(
        lambda: sheets.spreadsheets()
        .get(spreadsheetId=spreadsheet_id, fields="sheets.properties")
        .execute()
    )
    sheets_meta = meta.get("sheets") or []
    titles = [s["properties"]["title"] for s in sheets_meta]
    if name not in titles:
        sheet_queue._retry(
            lambda: sheets.spreadsheets()
            .batchUpdate(
                spreadsheetId=spreadsheet_id,
                body={"requests": [{"addSheet": {"properties": {"title": name}}}]},
            )
            .execute()
        )
    table = _sheet_table(sheets, spreadsheet_id, name)
    header = _header_names(table[0] if table else [])
    if header != HEADERS:
        _rewrite_sheet(sheets, spreadsheet_id, name, table, header, app_dir)
    return name


def init_sheet(app_dir) -> dict:
    cfg = load(app_dir)
    oauth = _require(cfg)
    drive, sheets = sheet_queue.services(oauth)
    sid = str(cfg.get("spreadsheet_id") or "").strip()
    folder = cfg["folder_id"]
    sheet_name = cfg.get("sheet_name") or "data"
    if not sid:
        body = {
            "name": "TikTok Data",
            "mimeType": "application/vnd.google-apps.spreadsheet",
            "parents": [str(folder).strip()],
        }
        created = sheet_queue._retry(
            lambda: drive.files().create(body=body, fields="id", supportsAllDrives=True).execute()
        )
        sid = created["id"]
        cfg["spreadsheet_id"] = sid
        save(app_dir, cfg)
    _ensure_sheet(sheets, sid, sheet_name, app_dir)
    return {"ok": True, "spreadsheet_id": sid}


def queue_stats(app_dir) -> dict:
    counts = {s: 0 for s in sheet_queue.STATUSES}
    cfg = load(app_dir)
    if not str(cfg.get("spreadsheet_id") or "").strip():
        return counts
    oauth = _require(cfg)
    _, sheets = sheet_queue.services(oauth)
    title = _ensure_sheet(sheets, cfg["spreadsheet_id"], cfg.get("sheet_name") or "data", app_dir)
    col = chr(ord("A") + HEADERS.index("status"))
    data = (
        sheet_queue._retry(
            lambda: sheets.spreadsheets()
            .values()
            .get(
                spreadsheetId=cfg["spreadsheet_id"],
                range=sheet_queue._a1(title, col + "2", col),
            )
            .execute()
        ).get("values")
        or []
    )
    for row in data:
        status = str(row[0] if row else "").strip().lower()
        if status in counts:
            counts[status] += 1
    return counts


def enqueue_output(output_path, app_dir, source_path="", enabled=None, on_progress=None, on_stage=None) -> dict:
    cfg = load(app_dir)
    want = cfg.get("enabled") if enabled is None else bool(enabled)
    if not want:
        return {"ok": False, "skipped": True}
    src = Path(str(output_path or ""))
    if not src.is_file():
        msg = "Không thấy file render: " + str(output_path)
        _write_log(app_dir, msg)
        return {"ok": False, "error": msg}
    try:
        oauth = _require(cfg)
        sid = str(cfg.get("spreadsheet_id") or "").strip()
        if not sid:
            raise RuntimeError("Chưa có Spreadsheet ID. Bấm khởi tạo Sheet.")
        drive, sheets = sheet_queue.services(oauth)
        if on_stage:
            on_stage("drive")
        up = sheet_queue.upload_video(drive, cfg["folder_id"], src, on_progress=on_progress)
        if on_stage:
            on_stage("sheet")
        channel = channel_from_path(source_path) or channel_from_path(src)
        row_id = uuid.uuid4().hex[:12]
        _save_file_row(app_dir, row_id, str(src), str(source_path or ""), up["id"])
        row = [
            row_id,
            sheet_queue._now(),
            src.name,
            channel,
            up["url"],
            "pending",
            "",
            "",
        ]
        title = _ensure_sheet(sheets, sid, cfg.get("sheet_name") or "data", app_dir)
        with sheet_queue._append_lock:
            sheet_queue._retry(
                lambda: sheets.spreadsheets()
                .values()
                .append(
                    spreadsheetId=sid,
                    range=sheet_queue._a1(title, "A1"),
                    valueInputOption="RAW",
                    insertDataOption="INSERT_ROWS",
                    body={"values": [row]},
                )
                .execute()
            )
    except Exception as exc:
        _write_log(app_dir, str(exc))
        return {"ok": False, "error": str(exc)}
    _write_log(app_dir, f"OK id={row_id} file={src.name} channel={channel or '-'}")
    return {
        "ok": True,
        "id": row_id,
        "drive_file_id": up["id"],
        "drive_url": up["url"],
        "channel": channel,
        "sheet_url": f"https://docs.google.com/spreadsheets/d/{sid}/edit",
    }


def _data_rows(sheets, spreadsheet_id: str, title: str) -> list[dict]:
    end = chr(ord("A") + len(HEADERS) - 1)
    data = (
        sheet_queue._retry(
            lambda: sheets.spreadsheets()
            .values()
            .get(
                spreadsheetId=spreadsheet_id,
                range=sheet_queue._a1(title, "A2", end),
            )
            .execute()
        ).get("values")
        or []
    )
    rows = []
    for i, raw in enumerate(data):
        cells = [str(x or "").strip() for x in (raw or [])]
        while len(cells) < len(HEADERS):
            cells.append("")
        rec = dict(zip(HEADERS, cells[: len(HEADERS)]))
        rec["_row"] = i + 2
        rows.append(rec)
    return rows


def _note_text(note) -> str:
    return " ".join(str(note or "").split())[:500]


def _set_note_cell(sheets, spreadsheet_id: str, title: str, row_num: int, note: str):
    note_col = chr(ord("A") + HEADERS.index("note"))
    row_num = int(row_num)
    text = _note_text(note)
    sheet_queue._retry(
        lambda: sheets.spreadsheets()
        .values()
        .update(
            spreadsheetId=spreadsheet_id,
            range=sheet_queue._a1(title, f"{note_col}{row_num}"),
            valueInputOption="RAW",
            body={"values": [[text]]},
        )
        .execute()
    )


def _set_status_cell(sheets, spreadsheet_id: str, title: str, row_num: int, status: str, note=None):
    status_col = chr(ord("A") + HEADERS.index("status"))
    time_col = chr(ord("A") + HEADERS.index("timepost"))
    note_col = chr(ord("A") + HEADERS.index("note"))
    posted_at = sheet_queue._now() if status == "posted" else ""
    row_num = int(row_num)
    end_col = note_col if note is not None else time_col
    values = [status, posted_at]
    if note is not None:
        values.append(_note_text(note))
    sheet_queue._retry(
        lambda: sheets.spreadsheets()
        .values()
        .update(
            spreadsheetId=spreadsheet_id,
            range=sheet_queue._a1(title, f"{status_col}{row_num}", f"{end_col}{row_num}"),
            valueInputOption="RAW",
            body={"values": [values]},
        )
        .execute()
    )


def _open_data_sheet(app_dir):
    cfg = load(app_dir)
    sid = str(cfg.get("spreadsheet_id") or "").strip()
    if not sid:
        raise RuntimeError("Sheet data chưa được cấu hình.")
    oauth = _require(cfg)
    _, sheets = sheet_queue.services(oauth)
    title = _ensure_sheet(sheets, sid, cfg.get("sheet_name") or "data", app_dir)
    return sheets, sid, title


def _norm_video_name(name: str) -> str:
    text = str(name or "").strip().lower()
    if text.endswith(".mp4"):
        text = text[:-4].strip()
    return " ".join(text.replace("_", " ").split())


def _drive_file_id(url: str) -> str:
    match = re.search(r"/file/d/([^/?#]+)", str(url or ""))
    return match.group(1) if match else ""


def _row_video_keys(rec: dict) -> set:
    keys = set()
    name = _norm_video_name(rec.get("video_name"))
    if name:
        keys.add("name:" + name)
    file_id = _drive_file_id(rec.get("drive_url"))
    if file_id:
        keys.add("file:" + file_id)
    return keys


def _pending_candidates(rows, channel: str):
    mine = [r for r in rows if str(r.get("channel") or "").strip() == channel]
    taken = set()
    for rec in mine:
        status = (rec.get("status") or "pending").strip().lower()
        if status in ("claimed", "posting", "posted"):
            taken |= _row_video_keys(rec)
    pending = []
    skipped = 0
    for rec in mine:
        status = (rec.get("status") or "pending").strip().lower()
        if status not in ("pending", ""):
            continue
        keys = _row_video_keys(rec)
        if keys and (keys & taken):
            skipped += 1
            continue
        pending.append(rec)
    return pending, skipped


def claim_for_channel(app_dir, channel_id: str) -> dict:
    channel = str(channel_id or "").strip()
    if not channel:
        return {"ok": False, "error": "Chưa có Channel ID."}
    try:
        sheets, sid, title = _open_data_sheet(app_dir)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    def _do():
        pending, skipped = _pending_candidates(_data_rows(sheets, sid, title), channel)
        missing = 0
        for rec in pending:
            path = str(_file_row(app_dir, rec.get("id")).get("output_path") or "")
            if not path or not Path(path).is_file():
                missing += 1
                continue
            _set_status_cell(sheets, sid, title, rec["_row"], "claimed", "Đang đăng")
            return {
                "ok": True,
                "id": rec.get("id") or "",
                "output_path": path,
                "video_name": rec.get("video_name") or "",
                "file_id": _drive_file_id(rec.get("drive_url")),
                "channel": channel,
                "row": rec["_row"],
            }
        if skipped and not missing:
            return {
                "ok": False,
                "empty": True,
                "error": f"Channel {channel}: video còn lại đã được nhận, bỏ qua để tránh đăng trùng.",
            }
        if missing:
            return {
                "ok": False,
                "error": f"Channel {channel}: {missing} dòng pending nhưng file không còn trên máy.",
            }
        return {
            "ok": False,
            "empty": True,
            "error": f"Không có video pending cho channel {channel}.",
        }

    got = sheet_queue._with_sheet_lock(sheets, sid, title, _do)
    if not got:
        return {"ok": False, "error": "Sheet đang bận, thử lại."}
    return got


def claimable_rows(rows) -> list[dict]:
    taken = set()
    for rec in rows or []:
        status = (rec.get("status") or "pending").strip().lower()
        if status in ("claimed", "posting", "posted"):
            taken |= _row_video_keys(rec)
    out = []
    for rec in rows or []:
        status = (rec.get("status") or "pending").strip().lower()
        if status not in ("pending", ""):
            continue
        keys = _row_video_keys(rec)
        if keys and (keys & taken):
            continue
        out.append(rec)
        taken |= keys
    return out


def list_claimable(app_dir) -> dict:
    try:
        sheets, sid, title = _open_data_sheet(app_dir)
        rows = _data_rows(sheets, sid, title)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "rows": []}
    ready = []
    for rec in claimable_rows(rows):
        path = str(_file_row(app_dir, rec.get("id")).get("output_path") or "")
        if not path or not Path(path).is_file():
            continue
        ready.append(
            {
                "id": rec.get("id") or "",
                "channel": rec.get("channel") or "",
                "video_name": rec.get("video_name") or "",
                "output_path": path,
                "file_id": _drive_file_id(rec.get("drive_url")),
            }
        )
    return {"ok": True, "rows": ready}


def claim_row(app_dir, row_id: str) -> dict:
    row_id = str(row_id or "").strip()
    if not row_id:
        return {"ok": False, "error": "empty_id"}
    try:
        sheets, sid, title = _open_data_sheet(app_dir)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    def _do():
        rows = _data_rows(sheets, sid, title)
        allowed = {str(rec.get("id") or ""): rec for rec in claimable_rows(rows)}
        rec = allowed.get(row_id)
        if not rec:
            return {"ok": False, "empty": True, "error": "Video đã được nhận."}
        file_row = _file_row(app_dir, row_id)
        path = str(file_row.get("output_path") or "")
        if not path or not Path(path).is_file():
            return {"ok": False, "error": "File video không còn trên máy."}
        file_id = str(file_row.get("drive_file_id") or "") or _drive_file_id(rec.get("drive_url"))
        _set_status_cell(sheets, sid, title, rec["_row"], "claimed", "Đang đăng")
        return {
            "ok": True,
            "id": row_id,
            "output_path": path,
            "video_name": rec.get("video_name") or "",
            "file_id": file_id,
            "channel": rec.get("channel") or "",
            "row": rec["_row"],
        }

    got = sheet_queue._with_sheet_lock(sheets, sid, title, _do)
    if not got:
        return {"ok": False, "error": "Sheet đang bận, thử lại."}
    return got


def set_row_status(app_dir, row_id: str, status: str, note=None) -> dict:
    row_id = str(row_id or "").strip()
    status = str(status or "").strip().lower()
    if not row_id:
        return {"ok": False, "error": "empty_id"}
    if status not in ("pending", "claimed", "posting", "posted", "failed"):
        return {"ok": False, "error": "status"}
    try:
        sheets, sid, title = _open_data_sheet(app_dir)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    def _do():
        for rec in _data_rows(sheets, sid, title):
            if rec.get("id") != row_id:
                continue
            _set_status_cell(sheets, sid, title, rec["_row"], status, note)
            return {"ok": True, "id": row_id, "status": status}
        return {"ok": False, "error": "not_found"}

    got = sheet_queue._with_sheet_lock(sheets, sid, title, _do)
    if not got:
        return {"ok": False, "error": "Sheet đang bận, thử lại."}
    return got


def set_row_note(app_dir, row_id: str, note: str, row_num: int = 0) -> dict:
    text = _note_text(note)
    row_id = str(row_id or "").strip()
    if not text or (not row_id and int(row_num or 0) < 2):
        return {"ok": False, "error": "empty"}
    try:
        sheets, sid, title = _open_data_sheet(app_dir)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    row_num = int(row_num or 0)
    if row_num < 2:
        for rec in _data_rows(sheets, sid, title):
            if rec.get("id") == row_id:
                row_num = int(rec["_row"])
                break
    if row_num < 2:
        return {"ok": False, "error": "not_found"}
    try:
        _set_note_cell(sheets, sid, title, row_num, text)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "id": row_id, "row": row_num}
