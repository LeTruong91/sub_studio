"""Máy Facebook: lấy job pending trên Sheet, tải mp4 về thư mục local.

Copy config/fb_queue.json + file OAuth JSON + google_oauth_token.json (sau lần đăng nhập) sang máy này.

  python fb_queue_worker.py --config "D:\\...\\config\\fb_queue.json" --out "D:\\fb_inbox" --once
  python fb_queue_worker.py --config "..." --out "D:\\fb_inbox" --loop --sleep 20
  python fb_queue_worker.py --config "..." --mark-posted JOBID
  python fb_queue_worker.py --config "..." --mark-failed JOBID --error "adb timeout"
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import sheet_queue


def _load_cfg(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    oauth = Path(data.get("oauth_json") or "")
    if not oauth.is_file():
        sys.exit("oauth_json trong config khong ton tai")
    if not data.get("spreadsheet_id"):
        sys.exit("Chua co spreadsheet_id")
    if not data.get("folder_id"):
        sys.exit("Chua co folder_id")
    return data


def _services(cfg: dict):
    return sheet_queue.services(Path(cfg["oauth_json"]))


def take_one(cfg: dict, out_dir: Path) -> dict | None:
    drive, sheets = _services(cfg)
    sid = cfg["spreadsheet_id"]
    name = cfg.get("sheet_name") or "jobs"
    worker = str(cfg.get("worker_id") or "fb-pc").strip() or "fb-pc"
    job = sheet_queue.claim(sheets, sid, worker, sheet_name=name)
    if not job:
        return None
    local_name = (job.get("id") or "job") + "_" + (job.get("video_name") or "video.mp4")
    dest = sheet_queue.download_video(drive, job["drive_file_id"], out_dir, local_name)
    if not sheet_queue.still_owned(sheets, sid, job, worker):
        try:
            dest.unlink()
        except Exception:
            pass
        return None
    return {
        "id": job["id"],
        "path": str(dest.resolve()),
        "caption": job.get("caption") or Path(dest).stem,
        "video_name": job.get("video_name") or dest.name,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--out", default="", help="Thu muc tai video")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--sleep", type=int, default=20)
    parser.add_argument("--mark-posted", default="")
    parser.add_argument("--mark-failed", default="")
    parser.add_argument("--error", default="")
    parser.add_argument("--page-id", default="", help="idPage ghi vao Sheet khi dang page")
    parser.add_argument("--worker", default="", help="Ghi de worker_id")
    args = parser.parse_args()

    cfg_path = Path(args.config)
    if not cfg_path.is_file():
        sys.exit("Khong thay file config")
    cfg = _load_cfg(cfg_path)
    if args.worker:
        cfg["worker_id"] = args.worker

    drive, sheets = _services(cfg)
    sid = cfg["spreadsheet_id"]
    sname = cfg.get("sheet_name") or "jobs"

    if args.mark_posted:
        rec = sheet_queue.set_status(
            sheets, sid, args.mark_posted, "posted", sheet_name=sname, page_id=args.page_id
        )
        if not rec:
            sys.exit("Khong thay job")
        try:
            sheet_queue.delete_drive_file(drive, rec.get("drive_file_id") or "")
            print("OK posted", args.mark_posted, "deleted drive")
        except Exception as exc:
            print("OK posted", args.mark_posted, "drive delete fail:", exc)
        return
    if args.mark_failed:
        rec = sheet_queue.set_status(
            sheets,
            sid,
            args.mark_failed,
            "failed",
            sheet_name=sname,
            error=args.error,
            page_id=args.page_id,
        )
        if not rec:
            sys.exit("Khong thay job")
        print("OK failed", args.mark_failed)
        return

    out_dir = Path(args.out or ".")
    if not args.once and not args.loop:
        args.once = True

    def run_once():
        job = take_one(cfg, out_dir)
        if not job:
            print("Khong co job pending")
            return False
        print("QUEUE_JOB " + json.dumps(job, ensure_ascii=False), flush=True)
        return True

    if args.once:
        run_once()
        return
    print("Loop hang doi, Ctrl+C de dung")
    while True:
        try:
            run_once()
        except Exception as exc:
            print("LOI:", exc)
        time.sleep(max(5, args.sleep))


if __name__ == "__main__":
    main()
