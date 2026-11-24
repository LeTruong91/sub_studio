# from pathlib import Path
# import sys

# if sys.stdout and hasattr(sys.stdout, "reconfigure"):
#     sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# from yt_dlp import YoutubeDL
# from yt_dlp.utils import DownloadError


# def _app_dir():
#     argv0 = Path(sys.argv[0] or "").resolve()
#     if argv0.suffix.lower() == ".exe":
#         return argv0.parent
#     if getattr(sys, "frozen", False):
#         return Path(sys.executable).resolve().parent
#     return Path(__file__).resolve().parent


# def _cookie_attempts():
#     """--cookies rồi --cookies-from-browser, đúng cách yt-dlp ghi trong FAQ."""
#     base = _app_dir()
#     attempts = []
#     for path in (base / "cookies" / "youtube.txt", base / "youtube_cookies.txt"):
#         if path.is_file():
#             attempts.append({"cookiefile": str(path)})
#     for browser in ("edge", "chrome", "firefox", "brave"):
#         attempts.append({"cookiesfrombrowser": (browser,)})
#     attempts.append({})
#     return attempts


# def _needs_cookie(exc):
#     low = str(exc or "").lower()
#     return (
#         "not a bot" in low
#         or "sign in to confirm" in low
#         or "page needs to be reloaded" in low
#         or "cookie" in low
#         or "dpapi" in low
#     )


# def extract_video(url):
#     last = None
#     for extra in _cookie_attempts():
#         opts = {
#             "skip_download": True,
#             "quiet": True,
#             "no_warnings": True,
#             "socket_timeout": 30,
#             "ignore_no_formats_error": True,
#         }
#         opts.update(extra)
#         try:
#             with YoutubeDL(opts) as ydl:
#                 return ydl.extract_info(url, download=False)
#         except DownloadError as exc:
#             last = exc
#             if _needs_cookie(exc):
#                 continue
#             raise
#     hint = _app_dir() / "cookies" / "youtube.txt"
#     raise RuntimeError(
#         "YouTube yêu cầu cookie. Xuất Netscape cookies (có LOGIN_INFO) vào " + str(hint)
#         + ". Cách xuất: https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies"
#     ) from last


# url = "https://www.youtube.com/watch?v=gXKy3GQJRKA"
# info = extract_video(url)
# segments = info.get("heatmap") or []
# if not segments:
#     print("Không có heatmap cho video này.")
# for seg in segments:
#     print(seg["start_time"], seg["end_time"], seg["value"])
# import json
# import re
# import sys
# import urllib.request
# from http.cookiejar import MozillaCookieJar
# from pathlib import Path

# sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# COOKIE_FILE = Path(r"D:\Affila_Tool\Sub_studio\New\cookies\youtube.txt")
# UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
#       "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")


# def _find_heat_node(node):
#     if isinstance(node, dict):
#         if node.get("markerType") == "MARKER_TYPE_HEATMAP" or "heatMarkers" in node:
#             return node
#         for v in node.values():
#             r = _find_heat_node(v)
#             if r:
#                 return r
#     elif isinstance(node, list):
#         for v in node:
#             r = _find_heat_node(v)
#             if r:
#                 return r
#     return None


# def get_heatmap(video_id, cookie_file=COOKIE_FILE):
#     url = f"https://www.youtube.com/watch?v={video_id}"
#     jar = MozillaCookieJar()
#     if cookie_file and Path(cookie_file).is_file():
#         jar.load(str(cookie_file), ignore_discard=True, ignore_expires=True)
#     opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

#     html = opener.open(urllib.request.Request(
#         url, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
#     ), timeout=30).read().decode("utf-8", "replace")

#     ver = re.search(r'"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"', html)
#     key = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html)
#     client_version = ver.group(1) if ver else "2.20250101.00.00"

#     api = "https://www.youtube.com/youtubei/v1/next?prettyPrint=false"
#     if key:
#         api += "&key=" + key.group(1)
#     body = json.dumps({
#         "context": {"client": {"clientName": "WEB", "clientVersion": client_version,
#                                "hl": "en", "gl": "US"}},
#         "videoId": video_id,
#     }).encode()
#     req = urllib.request.Request(api, data=body, headers={
#         "User-Agent": UA,
#         "Content-Type": "application/json",
#         "Origin": "https://www.youtube.com",
#         "Referer": url,
#         "X-Youtube-Client-Name": "1",
#         "X-Youtube-Client-Version": client_version,
#     })
#     data = json.loads(opener.open(req, timeout=30).read().decode("utf-8", "replace"))

#     node = _find_heat_node(data)
#     if not node:
#         return []
#     rows = []
#     for m in node.get("markers") or node.get("heatMarkers") or []:
#         r = m.get("heatMarkerRenderer", m)
#         start = int(r.get("startMillis", r.get("timeRangeStartMillis")))
#         dur = int(r.get("durationMillis", r.get("markerDurationMillis")))
#         val = float(r.get("intensityScoreNormalized",
#                           r.get("heatMarkerIntensityScoreNormalized")))
#         rows.append({"start_time": start / 1000,
#                      "end_time": (start + dur) / 1000,
#                      "value": val})
#     return rows


# if __name__ == "__main__":
#     rows = get_heatmap("SjrS3-fqMgw")
#     print("Số đoạn:", len(rows))
#     for r in sorted(rows, key=lambda r: r["value"], reverse=True)[:5]:
#         print(r)

import json
import re
import sys
import time
import urllib.error
import urllib.request
from http.cookiejar import MozillaCookieJar
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

COOKIE_FILE = Path(r"D:\Affila_Tool\Sub_studio\New\cookies\youtube.txt")
CACHE_DIR = Path(__file__).resolve().parent / "heatmap_cache"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")


def extract_video_id(url_or_id):
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/)([\w-]{11})", url_or_id)
    return m.group(1) if m else url_or_id


def fmt_time(sec):
    sec = int(sec)
    return f"{sec // 3600:02d}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def _find_heat_node(node):
    if isinstance(node, dict):
        if node.get("markerType") == "MARKER_TYPE_HEATMAP" or "heatMarkers" in node:
            return node
        for v in node.values():
            r = _find_heat_node(v)
            if r:
                return r
    elif isinstance(node, list):
        for v in node:
            r = _find_heat_node(v)
            if r:
                return r
    return None


def _fetch(video_id, cookie_file):
    url = f"https://www.youtube.com/watch?v={video_id}"
    jar = MozillaCookieJar()
    if cookie_file and Path(cookie_file).is_file():
        jar.load(str(cookie_file), ignore_discard=True, ignore_expires=True)
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    html = opener.open(urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    ), timeout=30).read().decode("utf-8", "replace")

    ver = re.search(r'"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"', html)
    key = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html)
    length = re.search(r'"lengthSeconds":"(\d+)"', html)
    client_version = ver.group(1) if ver else "2.20250101.00.00"
    duration = int(length.group(1)) if length else None

    api = "https://www.youtube.com/youtubei/v1/next?prettyPrint=false"
    if key:
        api += "&key=" + key.group(1)
    body = json.dumps({
        "context": {"client": {"clientName": "WEB", "clientVersion": client_version,
                               "hl": "en", "gl": "US"}},
        "videoId": video_id,
    }).encode()
    req = urllib.request.Request(api, data=body, headers={
        "User-Agent": UA,
        "Content-Type": "application/json",
        "Origin": "https://www.youtube.com",
        "Referer": url,
        "X-Youtube-Client-Name": "1",
        "X-Youtube-Client-Version": client_version,
    })
    data = json.loads(opener.open(req, timeout=30).read().decode("utf-8", "replace"))
    return data, duration


def _parse(data):
    node = _find_heat_node(data)
    if not node:
        return []
    rows = []
    for m in node.get("markers") or node.get("heatMarkers") or []:
        r = m.get("heatMarkerRenderer", m)
        start = int(r.get("startMillis", r.get("timeRangeStartMillis")))
        dur = int(r.get("durationMillis", r.get("markerDurationMillis")))
        val = float(r.get("intensityScoreNormalized",
                          r.get("heatMarkerIntensityScoreNormalized")))
        rows.append({"start_time": start / 1000,
                     "end_time": (start + dur) / 1000,
                     "value": val})
    return rows


def get_heatmap(url_or_id, cookie_file=COOKIE_FILE, use_cache=True, retries=2):
    """
    Trả về dict:
      {"video_id", "duration", "segment_len", "segments": [{start_time, end_time, value}, ...]}
    segments rỗng nghĩa là video không có heatmap (hoặc YouTube không trả).
    """
    video_id = extract_video_id(url_or_id)
    CACHE_DIR.mkdir(exist_ok=True)
    cache_file = CACHE_DIR / f"{video_id}.json"
    if use_cache and cache_file.is_file():
        return json.loads(cache_file.read_text(encoding="utf-8"))

    last_err = None
    for attempt in range(retries + 1):
        try:
            data, duration = _fetch(video_id, cookie_file)
            break
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as e:
            last_err = e
            time.sleep(2 * (attempt + 1))
    else:
        raise RuntimeError(f"Không lấy được dữ liệu cho {video_id}: {last_err}")

    segments = _parse(data)
    if segments and duration:
        end = segments[-1]["end_time"]
        if abs(end - duration) > duration * 0.02:
            print(f"[Cảnh báo] heatmap kết thúc ở {end:.0f}s nhưng video dài {duration}s")

    result = {
        "video_id": video_id,
        "duration": duration or (segments[-1]["end_time"] if segments else None),
        "segment_len": (segments[0]["end_time"] - segments[0]["start_time"]) if segments else None,
        "segments": segments,
    }
    if segments:  # chỉ cache khi có dữ liệu
        cache_file.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return result


def top_clips(hm, n=5, gap_segments=2, pad=30):
    """
    Chọn n đoạn cao nhất, không lấy các đoạn sát nhau (< gap_segments đoạn).
    pad: số giây mở rộng hai bên vì mỗi đoạn heatmap khá dài.
    """
    segs = hm["segments"]
    if not segs:
        return []
    min_gap = hm["segment_len"] * gap_segments
    duration = hm["duration"]
    picked = []
    for s in sorted(segs, key=lambda s: s["value"], reverse=True):
        if all(abs(s["start_time"] - p["start_time"]) >= min_gap for p in picked):
            picked.append(s)
        if len(picked) == n:
            break
    clips = []
    for s in sorted(picked, key=lambda s: s["start_time"]):
        clips.append({
            "start": max(0, s["start_time"] - pad),
            "end": min(duration, s["end_time"] + pad),
            "value": s["value"],
        })
    return clips


def merged_highlights(hm, n=5, pad=30):
    """Chọn các đỉnh heatmap. Đoạn chồng thời gian được gộp từ mốc sớm nhất tới mốc muộn nhất."""
    segs = hm.get("segments") or []
    if not segs:
        return []
    data = dict(hm)
    if not data.get("segment_len"):
        data["segment_len"] = max(1.0, float(segs[0]["end_time"]) - float(segs[0]["start_time"]))
    duration = float(data.get("duration") or segs[-1]["end_time"])
    anchors = top_clips(data, n=n, pad=pad)
    if not anchors:
        return []
    groups = [
        {"start": float(item["start"]), "end": float(item["end"]), "value": float(item["value"])}
        for item in anchors
    ]
    bases = [dict(item) for item in groups]
    for seg in segs:
        start = max(0.0, float(seg["start_time"]) - pad)
        end = min(duration, float(seg["end_time"]) + pad)
        value = float(seg["value"])
        if end - start < 1:
            continue
        for group, base in zip(groups, bases):
            if value < float(base["value"]) * 0.5:
                continue
            if start <= float(base["end"]) and end >= float(base["start"]):
                group["start"] = min(float(group["start"]), start)
                group["end"] = max(float(group["end"]), end)
                group["value"] = max(float(group["value"]), value)
    return merge_overlapping_clips(groups)


def merge_overlapping_clips(clips):
    """Gộp các đoạn chồng hoặc lồng nhau. Khoảng cách còn lại giữ nguyên."""
    merged = []
    for clip in sorted(clips or [], key=lambda item: (float(item["start"]), float(item["end"]))):
        start = float(clip["start"])
        end = max(start, float(clip["end"]))
        value = float(clip.get("value") or 0)
        if end - start < 1:
            continue
        if merged and start <= merged[-1]["end"]:
            merged[-1]["end"] = max(merged[-1]["end"], end)
            merged[-1]["value"] = max(merged[-1]["value"], value)
            continue
        merged.append({"start": start, "end": end, "value": value})
    return merged


def _chapters_from_markers(data, duration):
    found = []

    def add(start, title):
        try:
            sec = float(start)
        except (TypeError, ValueError):
            return
        if sec < 0:
            return
        found.append((sec, (title or "").strip() or "(không tên)"))

    def walk(node):
        if isinstance(node, dict):
            chapter = node.get("chapterRenderer")
            if isinstance(chapter, dict):
                title = chapter.get("title")
                if isinstance(title, dict):
                    title = title.get("simpleText") or ""
                add((chapter.get("timeRangeStartMillis") or 0) / 1000, title)
            if node.get("markerType") == "MARKER_TYPE_CHAPTERS":
                for marker in node.get("markers") or []:
                    title = marker.get("title")
                    if isinstance(title, dict):
                        title = title.get("simpleText") or title.get("runs") or ""
                    if isinstance(title, list):
                        title = "".join(str(part.get("text") or "") for part in title if isinstance(part, dict))
                    add((marker.get("startMillis") or 0) / 1000, title)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(data)
    return _chapters_from_points(found, duration)


def _chapters_from_points(found, duration):
    uniq = []
    seen = set()
    for start, title in sorted(found, key=lambda item: item[0]):
        key = int(start)
        if key in seen:
            continue
        seen.add(key)
        uniq.append((start, title))
    if len(uniq) < 3:
        return []
    chapters = []
    for index, (start, title) in enumerate(uniq):
        end = uniq[index + 1][0] if index + 1 < len(uniq) else (duration or start)
        chapters.append({"start": start, "end": end, "title": title})
    return chapters


def get_chapters(url_or_id, cookie_file=COOKIE_FILE):
    """Lấy chương từ YouTube hoặc từ mốc giờ trong mô tả."""
    video_id = extract_video_id(url_or_id)
    data, duration = _fetch(video_id, cookie_file)
    marked = _chapters_from_markers(data, duration)
    if marked:
        return marked

    jar = MozillaCookieJar()
    if cookie_file and Path(cookie_file).is_file():
        jar.load(str(cookie_file), ignore_discard=True, ignore_expires=True)
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    html = opener.open(urllib.request.Request(
        f"https://www.youtube.com/watch?v={video_id}",
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
    ), timeout=30).read().decode("utf-8", "replace")

    m = re.search(r'"shortDescription":"((?:[^"\\]|\\.)*)"', html)
    if not m:
        return []
    desc = json.loads('"' + m.group(1) + '"')
    length = re.search(r'"lengthSeconds":"(\d+)"', html)
    if length:
        duration = int(length.group(1))

    ts = re.compile(r"(?<!\d)(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?!\d)")
    found = []
    for line in desc.splitlines():
        t = ts.search(line)
        if not t:
            continue
        h, mi, s = int(t.group(1) or 0), int(t.group(2)), int(t.group(3))
        title = (line[:t.start()] + " " + line[t.end():]).strip(" \t-–—|•·:.)(]['\"►▶*")
        found.append((h * 3600 + mi * 60 + s, title or "(không tên)"))
    return _chapters_from_points(found, duration)


def _overlap(a1, a2, b1, b2):
    return max(0.0, min(a2, b2) - max(a1, b1))


def chapter_scores(hm, chapters):
    """Độ hot trung bình của từng chương (trung bình có trọng số theo độ chồng lấn)."""
    out = []
    for c in chapters:
        total_w = weighted = 0.0
        for s in hm["segments"]:
            w = _overlap(c["start"], c["end"], s["start_time"], s["end_time"])
            weighted += w * s["value"]
            total_w += w
        out.append({**c, "score": weighted / total_w if total_w else 0.0})
    return out


def chapters_in_clip(chapters, start, end):
    """Các chương nằm trong khoảng [start, end], kèm số giây chồng lấn."""
    res = []
    for c in chapters:
        ov = _overlap(c["start"], c["end"], start, end)
        if ov > 0:
            res.append({**c, "overlap": ov})
    return sorted(res, key=lambda c: c["overlap"], reverse=True)
if __name__ == "__main__":
    url = "https://www.youtube.com/watch?v=KmCdPQ2Xqhk"
    hm = get_heatmap(url)
    chapters = get_chapters(url)

    print("Video:", hm["video_id"], "| dài:", fmt_time(hm["duration"] or 0),
          "| số đoạn heatmap:", len(hm["segments"]), "| số chương:", len(chapters))

    if not hm["segments"]:
        sys.exit("Video này không có heatmap.")
    if not chapters:
        print("Video không có chương. Mô tả không có mốc giờ và YouTube không gửi danh sách chương.")

    print("\n== Đoạn đỉnh và bài nằm trong đó ==")
    for c in top_clips(hm, n=5):
        print(f"{fmt_time(c['start'])} -> {fmt_time(c['end'])} | value = {c['value']:.3f}")
        for ch in chapters_in_clip(chapters, c["start"], c["end"]):
            print(f"    - {fmt_time(ch['start'])}  {ch['title']}  (chồng lấn {ch['overlap']:.0f}s)")

    if chapters:
        print("\n== Top 10 bài theo độ hot trung bình ==")
        for ch in sorted(chapter_scores(hm, chapters), key=lambda c: c["score"], reverse=True)[:10]:
            print(f"{ch['score']:.3f}  {fmt_time(ch['start'])}  {ch['title']}")