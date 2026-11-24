"""Hàng đợi Google Sheet + file trên Drive. Không chứa video trong Sheet."""

from __future__ import annotations

import json
import random
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCOPES = [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/spreadsheets",
]

HEADERS = [
    "id",
    "created_at",
    "video_name",
    "caption",
    "drive_file_id",
    "drive_url",
    "status",
    "claimed_by",
    "claimed_at",
    "posted_at",
    "error",
    "idPage",
]

STATUSES = ("pending", "claimed", "posting", "posted", "failed")

_title_cache: dict[str, tuple[str, float]] = {}
_headers_ok: dict[str, float] = {}
_append_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _is_quota(exc: BaseException) -> bool:
    status = getattr(getattr(exc, "resp", None), "status", None)
    try:
        status = int(status) if status is not None else 0
    except Exception:
        status = 0
    msg = str(exc)
    return status in (429, 503) or "RATE_LIMIT" in msg or "Quota exceeded" in msg


def _retry(fn, tries: int = 8):
    delay = 2.0
    last = None
    for _ in range(tries):
        try:
            return fn()
        except Exception as exc:
            last = exc
            if not _is_quota(exc):
                raise
            time.sleep(delay + random.uniform(0.3, 2.5))
            delay = min(delay * 1.8, 40)
    raise last


def token_path_for(oauth_json: Path) -> Path:
    return Path(oauth_json).with_name("google_oauth_token.json")


def discard_token(oauth_json) -> bool:
    """Xóa token nằm cạnh file OAuth để lần kết nối sau đăng nhập lại."""
    oauth = Path(oauth_json or "")
    if not str(oauth):
        return False
    token = token_path_for(oauth)
    if token.resolve() == oauth.resolve():
        return False
    if not token.is_file():
        return False
    token.unlink()
    return True


def account_ready(oauth_json) -> bool:
    """Chỉ trả về tài khoản Google dùng được hay không. Không mở trình duyệt."""
    oauth = Path(oauth_json or "")
    if not oauth.is_file():
        return False
    try:
        data = _load_json(oauth)
    except Exception:
        return False
    if data.get("type") == "service_account":
        return True
    token = token_path_for(oauth)
    if not token.is_file():
        return False
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials

        creds = Credentials.from_authorized_user_file(str(token), SCOPES)
        if creds and creds.valid:
            return True
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            token.write_text(creds.to_json(), encoding="utf-8")
            return bool(creds.valid)
    except Exception:
        return False
    return False


def credentials(oauth_json: Path):
    data = _load_json(oauth_json)
    if data.get("type") == "service_account":
        from google.oauth2 import service_account

        return service_account.Credentials.from_service_account_file(
            str(oauth_json),
            scopes=["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets"],
        )

    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    token = token_path_for(oauth_json)
    creds = None
    if token.is_file():
        creds = Credentials.from_authorized_user_file(str(token), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(oauth_json), SCOPES)
            creds = flow.run_local_server(port=0)
        token.write_text(creds.to_json(), encoding="utf-8")
    return creds


def services(oauth_json: Path):
    from googleapiclient.discovery import build

    creds = credentials(oauth_json)
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)
    sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)
    return drive, sheets


def _a1(sheet: str, a: str, b: str | None = None) -> str:
    name = str(sheet or "jobs").replace("'", "''")
    if b:
        return f"'{name}'!{a}:{b}"
    return f"'{name}'!{a}"


def upload_video(drive, folder_id: str, file_path: Path, on_progress=None) -> dict:
    from googleapiclient.http import MediaFileUpload

    body = {"name": file_path.name, "parents": [str(folder_id).strip()]}
    fields = "id,name,webViewLink"

    if on_progress:
        media = MediaFileUpload(str(file_path), resumable=True, chunksize=8 * 1024 * 1024)
        request = drive.files().create(
            body=body, media_body=media, fields=fields, supportsAllDrives=True
        )
        on_progress(0)
        created = None
        last_pct = -1
        while created is None:
            status, created = request.next_chunk()
            if status:
                pct = int(status.progress() * 100)
                if pct != last_pct:
                    last_pct = pct
                    on_progress(pct)
        on_progress(100)
    else:
        media = MediaFileUpload(str(file_path), resumable=True)
        created = _retry(
            lambda: drive.files()
            .create(body=body, media_body=media, fields=fields, supportsAllDrives=True)
            .execute()
        )
    created = created or {}
    fid = created.get("id") or ""
    return {
        "id": fid,
        "name": created.get("name") or file_path.name,
        "url": created.get("webViewLink") or f"https://drive.google.com/file/d/{fid}/view",
    }


def download_video(drive, file_id: str, dest_dir: Path, name: str = "") -> Path:
    from googleapiclient.http import MediaIoBaseDownload
    import io

    dest_dir.mkdir(parents=True, exist_ok=True)
    meta = _retry(lambda: drive.files().get(fileId=file_id, fields="name", supportsAllDrives=True).execute())
    fname = name or meta.get("name") or f"{file_id}.mp4"
    dest = dest_dir / fname
    request = drive.files().get_media(fileId=file_id, supportsAllDrives=True)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    dest.write_bytes(buf.getvalue())
    return dest


def delete_drive_file(drive, file_id: str) -> None:
    fid = str(file_id or "").strip()
    if not fid:
        return
    _retry(lambda: drive.files().delete(fileId=fid, supportsAllDrives=True).execute())


def create_spreadsheet(drive, sheets, folder_id: str, title: str = "Reel Queue") -> str:
    body = {
        "name": title,
        "mimeType": "application/vnd.google-apps.spreadsheet",
        "parents": [str(folder_id).strip()],
    }
    created = _retry(lambda: drive.files().create(body=body, fields="id", supportsAllDrives=True).execute())
    sid = created["id"]
    ensure_headers(sheets, sid, "Sheet1")
    try:
        meta = sheets.spreadsheets().get(spreadsheetId=sid).execute()
        sheet_id = meta["sheets"][0]["properties"]["sheetId"]
        sheets.spreadsheets().batchUpdate(
            spreadsheetId=sid,
            body={
                "requests": [
                    {
                        "updateSheetProperties": {
                            "properties": {"sheetId": sheet_id, "title": "jobs"},
                            "fields": "title",
                        }
                    }
                ]
            },
        ).execute()
    except Exception:
        pass
    return sid


def _sheet_title(sheets, spreadsheet_id: str, preferred: str) -> str:
    preferred = str(preferred or "jobs").strip() or "jobs"
    key = spreadsheet_id + "|" + preferred
    now = time.time()
    hit = _title_cache.get(key)
    if hit and now - hit[1] < 300:
        return hit[0]
    meta = _retry(
        lambda: sheets.spreadsheets()
        .get(spreadsheetId=spreadsheet_id, fields="sheets.properties.title")
        .execute()
    )
    titles = [s["properties"]["title"] for s in meta.get("sheets") or []]
    if preferred in titles:
        title = preferred
    elif "jobs" in titles:
        title = "jobs"
    elif titles:
        title = titles[0]
    else:
        title = preferred
    _title_cache[key] = (title, now)
    return title


def ensure_headers(sheets, spreadsheet_id: str, sheet_name: str = "jobs") -> str:
    title = _sheet_title(sheets, spreadsheet_id, sheet_name)
    hk = spreadsheet_id + "|" + title
    now = time.time()
    if hk in _headers_ok and now - _headers_ok[hk] < 600:
        return title
    got = (
        _retry(
            lambda: sheets.spreadsheets()
            .values()
            .get(spreadsheetId=spreadsheet_id, range=_a1(title, "A1", "L1"))
            .execute()
        ).get("values")
        or []
    )
    row = got[0] if got else []
    if [str(x).strip() for x in row] != HEADERS:
        _retry(
            lambda: sheets.spreadsheets()
            .values()
            .update(
                spreadsheetId=spreadsheet_id,
                range=_a1(title, "A1", "L1"),
                valueInputOption="RAW",
                body={"values": [HEADERS]},
            )
            .execute()
        )
    _headers_ok[hk] = now
    return title


def _rec_from_raw(raw: list, row_index: int, title: str) -> dict:
    cells = list(raw) + [""] * (len(HEADERS) - len(raw))
    rec = {HEADERS[j]: str(cells[j] if j < len(cells) else "") for j in range(len(HEADERS))}
    rec["_row"] = row_index
    rec["_sheet"] = title
    return rec


def _rows(sheets, spreadsheet_id: str, sheet_name: str) -> list[dict]:
    title = ensure_headers(sheets, spreadsheet_id, sheet_name)
    data = (
        _retry(
            lambda: sheets.spreadsheets()
            .values()
            .get(spreadsheetId=spreadsheet_id, range=_a1(title, "A2", "L"))
            .execute()
        ).get("values")
        or []
    )
    out = []
    for i, raw in enumerate(data, start=2):
        out.append(_rec_from_raw(raw, i, title))
    return out


def enqueue(drive, sheets, folder_id: str, spreadsheet_id: str, file_path, sheet_name: str = "jobs", caption: str = "", on_progress=None, on_stage=None) -> dict:
    src = Path(file_path)
    if on_stage:
        on_stage("drive")
    up = upload_video(drive, folder_id, src, on_progress=on_progress)
    if on_stage:
        on_stage("sheet")
    job_id = uuid.uuid4().hex[:12]
    cap = (caption or src.stem).strip()
    row = [
        job_id,
        _now(),
        src.name,
        cap,
        up["id"],
        up["url"],
        "pending",
        "",
        "",
        "",
        "",
        "",
    ]
    with _append_lock:
        title = ensure_headers(sheets, spreadsheet_id, sheet_name)
        _retry(
            lambda: sheets.spreadsheets()
            .values()
            .append(
                spreadsheetId=spreadsheet_id,
                range=_a1(title, "A1"),
                valueInputOption="RAW",
                insertDataOption="INSERT_ROWS",
                body={"values": [row]},
            )
            .execute()
        )
        time.sleep(0.15)
    return {"id": job_id, "drive_file_id": up["id"], "drive_url": up["url"], "status": "pending"}


def _write_row(sheets, spreadsheet_id: str, rec: dict):
    title = rec["_sheet"]
    r = rec["_row"]
    values = [rec.get(h, "") for h in HEADERS]
    _retry(
        lambda: sheets.spreadsheets()
        .values()
        .update(
            spreadsheetId=spreadsheet_id,
            range=_a1(title, f"A{r}", f"L{r}"),
            valueInputOption="RAW",
            body={"values": [values]},
        )
        .execute()
    )


def _cell_get(sheets, spreadsheet_id: str, a1: str) -> str:
    data = (
        _retry(
            lambda: sheets.spreadsheets()
            .values()
            .get(spreadsheetId=spreadsheet_id, range=a1)
            .execute()
        ).get("values")
        or []
    )
    if not data or not data[0]:
        return ""
    return str(data[0][0] or "")


def _cell_set(sheets, spreadsheet_id: str, a1: str, value: str) -> None:
    _retry(
        lambda: sheets.spreadsheets()
        .values()
        .update(
            spreadsheetId=spreadsheet_id,
            range=a1,
            valueInputOption="RAW",
            body={"values": [[value]]},
        )
        .execute()
    )


def _with_sheet_lock(sheets, spreadsheet_id: str, title: str, fn):
    token = uuid.uuid4().hex
    rng = _a1(title, "Z1")
    for _ in range(20):
        _cell_set(sheets, spreadsheet_id, rng, token)
        time.sleep(0.55 + random.uniform(0.0, 0.45))
        if _cell_get(sheets, spreadsheet_id, rng) == token:
            try:
                return fn()
            finally:
                try:
                    if _cell_get(sheets, spreadsheet_id, rng) == token:
                        _cell_set(sheets, spreadsheet_id, rng, "")
                except Exception:
                    pass
        time.sleep(0.5 + random.uniform(0.0, 1.5))
    return None


def _is_stale(claimed_at: str, stale_sec: int) -> bool:
    if not claimed_at or stale_sec <= 0:
        return False
    try:
        ts = datetime.strptime(claimed_at.replace("Z", ""), "%Y-%m-%dT%H:%M:%S")
        ts = ts.replace(tzinfo=timezone.utc)
    except Exception:
        return False
    return (datetime.now(timezone.utc) - ts).total_seconds() > stale_sec


def still_owned(sheets, spreadsheet_id: str, rec: dict, worker_id: str) -> bool:
    title = rec.get("_sheet") or "jobs"
    try:
        r = int(rec.get("_row") or 0)
    except Exception:
        r = 0
    if r <= 0:
        return False
    data = (
        _retry(
            lambda: sheets.spreadsheets()
            .values()
            .get(spreadsheetId=spreadsheet_id, range=_a1(title, f"A{r}", f"L{r}"))
            .execute()
        ).get("values")
        or []
    )
    if not data:
        return False
    row = _rec_from_raw(data[0], r, title)
    st = (row.get("status") or "").strip().lower()
    if st in ("posted", "failed"):
        return False
    return (row.get("claimed_by") or "").strip() == str(worker_id or "").strip()


def claim(sheets, spreadsheet_id: str, worker_id: str, sheet_name: str = "jobs", stale_sec: int = 1800) -> dict | None:
    worker_id = str(worker_id or "worker").strip()
    title = _sheet_title(sheets, spreadsheet_id, sheet_name)

    def _do():
        jobs = _rows(sheets, spreadsheet_id, sheet_name)
        pick = None
        for rec in jobs:
            st = (rec.get("status") or "").strip().lower()
            if st == "pending":
                pick = rec
                break
            if st in ("claimed", "posting") and _is_stale(rec.get("claimed_at") or "", stale_sec):
                pick = rec
                break
        if not pick:
            return None
        pick["status"] = "claimed"
        pick["claimed_by"] = worker_id
        pick["claimed_at"] = _now()
        _write_row(sheets, spreadsheet_id, pick)
        return pick

    return _with_sheet_lock(sheets, spreadsheet_id, title, _do)


def set_status(sheets, spreadsheet_id: str, job_id: str, status: str, sheet_name: str = "jobs", error: str = "", worker_id: str = "", page_id: str = "") -> dict | None:
    status = str(status or "").strip().lower()
    if status not in STATUSES:
        raise ValueError(status)
    for rec in _rows(sheets, spreadsheet_id, sheet_name):
        if rec.get("id") != job_id:
            continue
        rec["status"] = status
        if worker_id:
            rec["claimed_by"] = worker_id
        if status in ("claimed", "posting") and not rec.get("claimed_at"):
            rec["claimed_at"] = _now()
        if status == "posted":
            rec["posted_at"] = _now()
            rec["error"] = ""
        if status == "failed":
            rec["error"] = (error or "")[:500]
        if page_id:
            rec["idPage"] = str(page_id).strip()
        _write_row(sheets, spreadsheet_id, rec)
        return rec
    return None


def stats(sheets, spreadsheet_id: str, sheet_name: str = "jobs") -> dict:
    counts = {s: 0 for s in STATUSES}
    for rec in _rows(sheets, spreadsheet_id, sheet_name):
        st = (rec.get("status") or "").strip().lower()
        if st in counts:
            counts[st] += 1
    counts["total"] = sum(counts.values())
    return counts
