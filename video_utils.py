
"""
video_utils.py
--------------
...
"""
import json
import math
import struct
import subprocess
import threading
from pathlib import Path
from datetime import datetime
import base64
import tempfile
import os
import shutil
import traceback
from render_option import get_render_option
import random
import re
import copy
import sys
import glob
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import uuid
from subprocess_utils import popen_hidden, run_hidden
from PIL import Image, ImageDraw, ImageFont

if getattr(sys, "frozen", False):
    # Đang chạy từ file exe đã build (PyInstaller)
    BASE_DIR = Path(sys.executable).resolve().parent
else:
    # Đang chạy bằng python main.py (dev mode)
    BASE_DIR = Path(__file__).resolve().parent

FFMPEG_EXE = BASE_DIR / "ffmpeg" / "ffmpeg.exe"
FFPROBE_EXE = BASE_DIR / "ffmpeg" / "ffprobe.exe"
DEFAULT_OVERLAY_FOLDER = BASE_DIR / "VideoOverlay"
# BASE_DIR = Path(__file__).resolve().parent
# FFMPEG_EXE = BASE_DIR / "ffmpeg" / "ffmpeg.exe"
# FFPROBE_EXE = BASE_DIR / "ffmpeg" / "ffprobe.exe"
# DEFAULT_OVERLAY_FOLDER = BASE_DIR / "VideoOverlay"
import sketch_effect
import srt_to_ass
import subtitle_utils 

class FFmpegError(RuntimeError):
    pass
class ContentPicker:
    """
    Random không lặp cho tới khi dùng hết danh sách -> tự động trộn lại (vòng mới).
    Dùng CHUNG 1 instance cho cả batch render (không tạo mới cho mỗi video/hook).
    """
    def __init__(self, contents: list):
        self.contents = list(contents)
        self.queue = []
        self.last_picked = None

    def _refill(self):
        pool = self.contents.copy()
        random.shuffle(pool)

        # Tránh trường hợp câu cuối vòng trước trùng với câu đầu vòng mới
        # (để không bị 2 video liên tiếp cùng nội dung)
        if self.last_picked is not None and len(pool) > 1 and pool[0] == self.last_picked:
            idx = random.randint(1, len(pool) - 1)
            pool[0], pool[idx] = pool[idx], pool[0]

        self.queue = pool

    def pick(self) -> str:
        if not self.contents:
            return ""
        if not self.queue:
            self._refill()
        item = self.queue.pop(0)
        self.last_picked = item
        return item

# ==================================================
# TRACKING PROCESS ĐANG CHẠY (để hỗ trợ Stop)
# ==================================================
_active_processes = {}          # key -> subprocess.Popen
_active_lock = threading.Lock()
_stop_all_flag = False          # bật True khi người dùng bấm "Dừng tất cả"
def _safe_print(*args, **kwargs):
    try:
        print(*args, **kwargs)
    except UnicodeEncodeError:
        pass
def is_stopping():
    return _stop_all_flag

def _run(cmd, track_key=None):
    """Chạy ffmpeg, có track process để có thể stop() giữa chừng."""
    global _stop_all_flag

    if _stop_all_flag:
        raise FFmpegError("Đã bị dừng trước khi bắt đầu.")

    process = popen_hidden(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    if track_key:
        with _active_lock:
            _active_processes[track_key] = process

    stdout, stderr = process.communicate()

    if track_key:
        with _active_lock:
            _active_processes.pop(track_key, None)

    if process.returncode != 0:
        # nếu bị terminate() chủ động, coi đó là "đã dừng" chứ không phải lỗi thật
        stderr_text = stderr.decode("utf-8", errors="ignore")
        raise FFmpegError(stderr_text)

    return process

def _runProgress(cmd, track_key=None, duration_seconds=0, on_progress=None,out_video=None):
    """
    Chạy ffmpeg, có track process để có thể stop() giữa chừng.
    Đọc song song cả stdout (progress) và stderr (log) để tránh deadlock do pipe đầy.
    """
    global _stop_all_flag

    if _stop_all_flag:
        raise FFmpegError("Đã bị dừng trước khi bắt đầu.")

    cmd_with_progress = [cmd[0], "-progress", "pipe:1", "-nostats"] + cmd[1:]

    process = popen_hidden(
        cmd_with_progress,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1
    )

    if track_key:
        with _active_lock:
            _active_processes[track_key] = process

    # ---- Thread riêng để "hút" stderr liên tục, tránh làm đầy buffer gây deadlock ----
    stderr_lines = []

    def _drain_stderr():
        try:
            for line in process.stderr:
                stderr_lines.append(line)
                # _safe_print("[FFMPEG]", line.rstrip()) 
        except Exception:
            pass

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    last_percent = -1

    try:
        for line in process.stdout:
            line = line.strip()

            if line.startswith("out_time_ms=") and duration_seconds > 0:
                try:
                    out_time_ms = int(line.split("=")[1])
                    current_seconds = out_time_ms / 1_000_000
                    percent = min(100, round((current_seconds / duration_seconds) * 100))

                    if percent != last_percent:
                        last_percent = percent
                        if on_progress:
                            on_progress(percent)
                except (ValueError, ZeroDivisionError):
                    pass

        process.wait()
        stderr_thread.join(timeout=5)
        stderr_output = "".join(stderr_lines)

    finally:
        if track_key:
            with _active_lock:
                _active_processes.pop(track_key, None)

    if process.returncode != 0:
        try:
            Path(out_video).unlink(missing_ok=True)
        except Exception:
            pass
        raise FFmpegError(stderr_output or "FFmpeg đã dừng hoặc gặp lỗi không rõ nguyên nhân.")

    return process
def stop_job(track_key):
    """Dừng 1 job cụ thể (theo input_path chẳng hạn)."""
    with _active_lock:
        proc = _active_processes.get(track_key)
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        return True
    return False


def stop_all_jobs():
    """Dừng toàn bộ job đang chạy, và chặn job mới bắt đầu (nếu gọi trước khi start)."""
    global _stop_all_flag
    _stop_all_flag = True

    with _active_lock:
        procs = list(_active_processes.values())
        _active_processes.clear()

    for proc in procs:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()


def reset_stop_flag():
    """Gọi khi bắt đầu 1 batch MỚI, để cho phép chạy lại sau khi đã stop trước đó."""
    global _stop_all_flag
    _stop_all_flag = False


def _path_non_ascii(p) -> bool:
    try:
        str(p).encode("ascii")
        return False
    except UnicodeEncodeError:
        return True


def _prepare_ffmpeg_unicode_io(src: Path, dst: Path):
    """FFmpeg trên Windows hay kẹt với tên Unicode (vd. Ảnh_nền.mp4). Copy sang path ASCII tạm."""
    work = None
    src_use = Path(src)
    if src_use.exists() and _path_non_ascii(src_use):
        work = Path(tempfile.mkdtemp(prefix="rs_ffio_"))
        src_use = work / ("in" + (Path(src).suffix.lower() or ".mp4"))
        shutil.copy2(src, src_use)
    dst_use = Path(dst)
    if _path_non_ascii(dst_use):
        if work is None:
            work = Path(tempfile.mkdtemp(prefix="rs_ffio_"))
        dst_use = work / "out.mp4"
    return src_use, dst_use, work


def _finalize_ffmpeg_unicode_io(ff_out: Path, final_out: Path, work):
    ff_out = Path(ff_out)
    final_out = Path(final_out)
    if ff_out.resolve() != final_out.resolve():
        if ff_out.is_file():
            final_out.parent.mkdir(parents=True, exist_ok=True)
            if final_out.exists():
                final_out.unlink()
            shutil.move(str(ff_out), str(final_out))
    if work:
        shutil.rmtree(work, ignore_errors=True)


def _cleanup_render_temps(*video_paths):
    """Xóa .ass / .png / .srt phụ do overlay subtitle/text tạo cạnh file nguồn."""
    seen = set()
    for vp in video_paths:
        if not vp:
            continue
        p = Path(vp)
        try:
            key = str(p.resolve())
        except Exception:
            key = str(p)
        if key in seen:
            continue
        seen.add(key)
        parent = p.parent
        stem = p.stem
        targets = [
            parent / f"{stem}.ass",
            parent / f"{stem}_layer_sub.srt",
            parent / f"{stem}_layer_sub_box.png",
        ]
        try:
            targets.extend(parent.glob(f"{stem}_layer_text_*.ass"))
            targets.extend(parent.glob(f"{stem}_layer_text_box_*.png"))
        except Exception:
            pass
        for f in targets:
            try:
                if f.is_file():
                    f.unlink()
            except Exception:
                pass


def validate_input_paths(input_paths: list) -> tuple[bool, str]:
    """Kiểm tra path có ký tự gây lỗi ffmpeg không. Trả (ok, message)."""
    bad_files = []
    for p in input_paths:
        name = Path(p).name
        if '"' in name or "'" in name:
            bad_files.append(name)
    if bad_files:
        msg = "Tên file chứa dấu ngoặc kép (\" hoặc ') gây lỗi khi xử lý: " + ", ".join(bad_files)
        return False, msg
    return True, ""    
def time_to_seconds(time_str):
    h, m, s = map(int, time_str.split(":"))
    return h * 3600 + m * 60 + s
def split_hook_text(text: str, word_count) -> tuple[str, str]:
    if not text:
        return "", ""

    words = [w for w in re.split(r"\s+", text.strip()) if w]
    n = max(1, int(word_count) if word_count else 1)

    if len(words) <= n:
        return text.strip(), ""

    line1 = " ".join(words[:n])
    line2 = " ".join(words[n:])
    return line1, line2
def get_video_info(path):
    try:
        cmd = [
            str(FFPROBE_EXE),
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-show_format",
            path
        ]
        result = run_hidden(cmd, capture_output=True, text=True, encoding="utf-8")
        data = json.loads(result.stdout)
        stream = next((s for s in data["streams"] if s["codec_type"] == "video"), {})
        duration = float(data["format"]["duration"])
        width = stream.get("width", 0)
        height = stream.get("height", 0)
        return duration, width, height
    except Exception:
        return 0, 0, 0
def escape_text_for_ffmpeg(text: str) -> str:
    """
    Escape text để dùng trong filter drawtext của FFmpeg.
    """

    if text is None:
        return ""

    return (
        text.replace("\\", "\\\\")   # \  -> \\
            .replace(":", r"\:")
            .replace("'", r"\'")
            .replace(",", r"\,")
            .replace("[", r"\[")
            .replace("]", r"\]")
            .replace(";", r"\;")
            .replace("%", r"\%")
            .replace("\n", r"\n")
            .replace("\r", "")
    )


def _ff_comma(expr: str) -> str:
    return (expr or "").replace(",", r"\,")


def _enable_between(t0, t1) -> str:
    return f":enable='between(t\\,{float(t0):.3f}\\,{float(t1):.3f})'"


def _font_px(value, default=18, min_v=1):
    """Cùng quy tắc làm tròn với preview (Math.round)."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        try:
            n = float(default)
        except (TypeError, ValueError):
            n = 18.0
    return max(min_v, int(round(n)))


# CSS font-size = 1 em (unitsPerEm). Browser (USE_TYPO_METRICS) dùng sTypo/hhea.
# libass/GDI scale Fontsize theo OS/2 usWinAscent+usWinDescent — Anton ~1.73, không phải 1.51.
_ASS_FS_VS_CSS = 1.22
_ass_fs_factor_cache = {}


def _sfnt_table_offsets(data, start=0):
    if start + 12 > len(data):
        return {}
    num_tables = struct.unpack(">H", data[start + 4 : start + 6])[0]
    pos = start + 12
    out = {}
    for _ in range(num_tables):
        if pos + 16 > len(data):
            break
        tag = data[pos : pos + 4]
        off = struct.unpack(">I", data[pos + 8 : pos + 12])[0]
        out[tag] = off
        pos += 16
    return out


def _bundled_font_dirs():
    dirs = []
    if getattr(sys, "frozen", False):
        meipass = Path(getattr(sys, "_MEIPASS", "") or ".")
        exe_dir = Path(sys.executable).resolve().parent
        dirs += [
            meipass / "web" / "fonts",
            exe_dir / "web" / "fonts",
            exe_dir / "_internal" / "web" / "fonts",
        ]
    else:
        dirs.append(Path(__file__).resolve().parent / "web" / "fonts")
    out = []
    seen = set()
    for d in dirs:
        try:
            p = d.resolve()
        except Exception:
            p = d
        key = str(p).lower()
        if key in seen:
            continue
        seen.add(key)
        if p.is_dir():
            out.append(p)
    return out


def _resolve_font_file(font_file="") -> str:
    """Dev: path gốc. Build: _MEIPASS/_internal/web/fonts hoặc cạnh exe — template hay lưu path máy cũ."""
    raw = str(font_file or "").strip()
    candidates = []
    if raw:
        candidates.append(Path(raw))
        try:
            candidates.append(Path(raw).expanduser())
        except Exception:
            pass
        name = Path(raw.replace("\\", "/")).name
        if name:
            for folder in _bundled_font_dirs():
                candidates.append(folder / name)
    for c in candidates:
        try:
            if c.is_file():
                return str(c.resolve())
        except Exception:
            continue
    return raw


def _decode_sfnt_name(plat, enc, raw: bytes) -> str:
    if not raw:
        return ""
    try:
        if plat == 3:
            return raw.decode("utf-16-be", errors="ignore").strip("\x00").strip()
        if plat == 1:
            return raw.decode("mac_roman", errors="ignore").strip("\x00").strip()
        return raw.decode("utf-8", errors="ignore").strip("\x00").strip()
    except Exception:
        return ""


def _font_ass_family(font_file="", fallback="") -> str:
    """Tên family trong file font (libass/ASS). Không dùng tên file / label UI."""
    path = _resolve_font_file(font_file)
    fb = str(fallback or "").strip()
    if not path or not Path(path).is_file():
        return fb
    try:
        data = Path(path).read_bytes()
        start = 0
        if data[:4] == b"ttcf" and len(data) >= 16:
            start = struct.unpack(">I", data[12:16])[0]
        tables = _sfnt_table_offsets(data, start)
        noff = tables.get(b"name")
        if noff is None or noff + 6 > len(data):
            return fb
        _fmt, count, str_off = struct.unpack(">HHH", data[noff : noff + 6])
        store = noff + str_off
        recs = noff + 6
        by_id = {}
        for i in range(count):
            rec = recs + i * 12
            if rec + 12 > len(data):
                break
            plat, enc, _lang, nid, length, off = struct.unpack(">HHHHHH", data[rec : rec + 12])
            if nid not in (1, 4, 16):
                continue
            raw_s = data[store + off : store + off + length]
            s = _decode_sfnt_name(plat, enc, raw_s)
            if not s:
                continue
            rank = 0
            if plat == 3 and enc in (1, 10):
                rank = 2
            elif plat == 3:
                rank = 1
            prev = by_id.get(nid)
            if prev is None or rank > prev[0]:
                by_id[nid] = (rank, s)
        for nid in (16, 1, 4):
            if nid in by_id:
                return by_id[nid][1]
    except Exception:
        pass
    return fb


def _layer_font_file(data, file_key="FontFile", name_key="FontName") -> str:
    data = data or {}
    raw = str(data.get(file_key) or "").strip()
    resolved = _resolve_font_file(raw)
    if resolved and Path(resolved).is_file():
        return str(Path(resolved).resolve())
    name = str(data.get(name_key) or "").strip()
    if not name:
        return resolved or raw
    stems = {name, name.replace(" ", "-"), name.replace("-", " ")}
    for folder in _bundled_font_dirs():
        try:
            for p in folder.iterdir():
                if p.suffix.lower() in (".ttf", ".otf", ".ttc") and p.stem in stems:
                    return str(p.resolve())
        except Exception:
            continue
    return resolved or raw


def _ass_fontsdir_opt(font_file="") -> str:
    resolved = _resolve_font_file(font_file)
    folder = None
    if resolved and Path(resolved).is_file():
        folder = Path(resolved).resolve().parent
    elif _bundled_font_dirs():
        folder = _bundled_font_dirs()[0]
    if not folder:
        return ""
    return ":fontsdir=" + prepare_font_path_for_ffmpeg(str(folder))


def _round_fs_factor(factor):
    if factor is None or factor < 1.05 or factor > 2.05:
        return None
    return math.floor(factor * 100.0 + 0.5) / 100.0


def _libass_line_factor_from_bytes(data, start=0):
    """Hệ số ASS: ưu tiên OS/2 win (libass/GDI), fallback hhea."""
    tables = _sfnt_table_offsets(data, start)
    head_off = tables.get(b"head")
    if head_off is None or head_off + 20 > len(data):
        return None
    units = struct.unpack(">H", data[head_off + 18 : head_off + 20])[0]
    if units <= 0:
        return None
    os2_off = tables.get(b"OS/2")
    if os2_off is not None and os2_off + 78 <= len(data):
        win_ascent = struct.unpack(">H", data[os2_off + 74 : os2_off + 76])[0]
        win_descent = struct.unpack(">H", data[os2_off + 76 : os2_off + 78])[0]
        win = _round_fs_factor((int(win_ascent) + int(win_descent)) / float(units))
        if win:
            return win
    hhea_off = tables.get(b"hhea")
    if hhea_off is None or hhea_off + 8 > len(data):
        return None
    ascent = struct.unpack(">h", data[hhea_off + 4 : hhea_off + 6])[0]
    descent = struct.unpack(">h", data[hhea_off + 6 : hhea_off + 8])[0]
    return _round_fs_factor((abs(int(ascent)) + abs(int(descent))) / float(units))


def _ass_fs_factor(font_file="") -> float:
    """Hệ số bù ASS theo OS/2 win metrics (libass). Không đọc được thì 1.22."""
    path = _resolve_font_file(font_file)
    if not path or not Path(path).is_file():
        return _ASS_FS_VS_CSS
    key = str(Path(path).resolve())
    if key in _ass_fs_factor_cache:
        return _ass_fs_factor_cache[key]
    factor = _ASS_FS_VS_CSS
    try:
        data = Path(key).read_bytes()
        if data[:4] == b"ttcf" and len(data) >= 16:
            off0 = struct.unpack(">I", data[12:16])[0]
            got = _libass_line_factor_from_bytes(data, off0)
        else:
            got = _libass_line_factor_from_bytes(data, 0)
        if got:
            factor = got
    except Exception:
        factor = _ASS_FS_VS_CSS
    _ass_fs_factor_cache[key] = factor
    return factor


def debug_log_font_ass(title, **fields):
    """Ghi log ra file cạnh exe (dev: thư mục project): debug_font_ass.txt."""
    try:
        log_path = BASE_DIR / "debug_font_ass.txt"
        lines = [
            "",
            "=" * 64,
            datetime.now().strftime("%Y-%m-%d %H:%M:%S") + "  " + str(title),
            f"frozen={bool(getattr(sys, 'frozen', False))}",
            f"executable={sys.executable}",
            f"MEIPASS={getattr(sys, '_MEIPASS', '')}",
            f"BASE_DIR={BASE_DIR}",
            "font_dirs=" + (" | ".join(str(d) for d in _bundled_font_dirs()) or "(none)"),
        ]
        for key, val in fields.items():
            lines.append(f"{key}={val}")
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    except Exception:
        pass


def inspect_font_metrics(font_file=""):
    raw = str(font_file or "").strip()
    resolved = _resolve_font_file(raw)
    info = {
        "FontFile_js": raw or "(empty)",
        "resolved": resolved or "(none)",
        "exists": False,
        "factor": _ASS_FS_VS_CSS,
        "factor_source": "fallback_1.22",
    }
    path = Path(resolved) if resolved else None
    if path is None or not path.is_file():
        info["error"] = "khong_tim_thay_file_font"
        return info
    info["exists"] = True
    info["resolved"] = str(path.resolve())
    try:
        data = path.read_bytes()
        start = 0
        if data[:4] == b"ttcf" and len(data) >= 16:
            start = struct.unpack(">I", data[12:16])[0]
            info["sfnt"] = "ttc"
        else:
            info["sfnt"] = data[:4].decode("latin-1", errors="replace")
        tables = _sfnt_table_offsets(data, start)
        info["has_OS2"] = b"OS/2" in tables
        info["has_hhea"] = b"hhea" in tables
        head_off = tables.get(b"head")
        units = 0
        if head_off is not None and head_off + 20 <= len(data):
            units = struct.unpack(">H", data[head_off + 18 : head_off + 20])[0]
            info["unitsPerEm"] = units
        os2_off = tables.get(b"OS/2")
        if os2_off is not None and os2_off + 78 <= len(data) and units:
            win_ascent = struct.unpack(">H", data[os2_off + 74 : os2_off + 76])[0]
            win_descent = struct.unpack(">H", data[os2_off + 76 : os2_off + 78])[0]
            info["win_ascent"] = win_ascent
            info["win_descent"] = win_descent
            info["win_ratio"] = round((win_ascent + win_descent) / float(units), 4)
            fs_sel = struct.unpack(">H", data[os2_off + 62 : os2_off + 64])[0]
            info["USE_TYPO_METRICS"] = bool(fs_sel & 0x80)
        hhea_off = tables.get(b"hhea")
        if hhea_off is not None and hhea_off + 8 <= len(data) and units:
            ascent = struct.unpack(">h", data[hhea_off + 4 : hhea_off + 6])[0]
            descent = struct.unpack(">h", data[hhea_off + 6 : hhea_off + 8])[0]
            info["hhea_ascent"] = ascent
            info["hhea_descent"] = descent
            info["typo_ratio"] = round((abs(ascent) + abs(descent)) / float(units), 4)
        factor = _libass_line_factor_from_bytes(data, start)
        if factor:
            info["factor"] = factor
            info["factor_source"] = "os2_win_or_hhea"
    except Exception as ex:
        info["error"] = repr(ex)
    return info


def debug_log_ass_fontsize(kind, css_px, out_fs, font_file, extra=None):
    meta = inspect_font_metrics(font_file)
    fields = {
        "layer": kind,
        "css_px_from_js": css_px,
        "ass_fs_out": out_fs,
        **meta,
    }
    if extra:
        fields.update(extra)
    debug_log_font_ass("ASS fontsize", **fields)


def _fmt_ass_fs(fs) -> str:
    """ASS \\fs nhận số thập phân; không ép int (69*1.22=84.18 không thành 84)."""
    n = float(fs)
    if n < 1:
        n = 1.0
    if abs(n - round(n)) < 0.005:
        return str(int(round(n)))
    return f"{n:.2f}"


def _css_fontsize_to_ffmpeg(css_px, scale_y=1, kind="drawtext", font_file=""):
    """css_px = cỡ JS đã scale preview→video. ASS × metrics font; drawtext làm tròn int."""
    try:
        out = float(css_px)
    except (TypeError, ValueError):
        out = 18.0
    if str(kind or "").lower() == "ass":
        factor = _ass_fs_factor(font_file)
        out *= factor
        result = max(1.0, round(out, 2))
        debug_log_ass_fontsize("ass", css_px, result, font_file, extra={"factor_used": factor})
        return result
    return max(1, int(round(out)))


def _hook_drawtext_fx(style, start, end, font_size, pos_x, pos_y, box_color="black@0.72"):
    """TikTok-like extras for drawtext. fontsize luôn là số nguyên (FFmpeg này không nhận expr)."""
    style = str(style or "default").strip().lower()
    extra = []
    fs = str(max(1, int(round(float(font_size)))))
    x, y = pos_x, pos_y
    t0 = f"{float(start or 0):.3f}"
    dt = f"(t-{t0})"

    if style == "box":
        extra += ["box=1", "boxborderw=14", f"boxcolor={box_color}"]
    elif style == "shadow":
        extra += ["shadowx=4", "shadowy=4", "shadowcolor=black@0.88"]

    if style == "slide":
        y = _ff_comma(f"({pos_y})+if(lt({dt},0.22),40*(1-{dt}/0.22),0)")
    elif style == "fade":
        extra.append(
            "alpha="
            + _ff_comma(
                f"if(lt({dt},0.2),{dt}/0.2,"
                f"if(gt(t,{float(end or 0):.3f}-0.16),({float(end or 0):.3f}-t)/0.16,1))"
            )
        )

    extra_str = (":" + ":".join(extra)) if extra else ""
    return fs, x, y, extra_str


def _append_hook_drawtext(
    filters, current_stream, out, text, font_file, font_size, font_color,
    border_str, pos_x, pos_y, enable, style, start, end, box_color="black@0.72",
) -> str:
    style = str(style or "default").strip().lower()
    if style == "neon":
        style = "default"
    font_file_q = prepare_font_path_for_ffmpeg(font_file)

    def _one(stream, label, fs, x, y, fx, en):
        filters.append(
            f"[{stream}]drawtext="
            f"text='{text}':"
            f"fontfile={font_file_q}:"
            f"fontsize={fs}:"
            f"fontcolor={font_color}"
            f"{border_str}{fx}:"
            f"x={x}:y={y}"
            f"{en}"
            f"[{label}]"
        )
        return label

    # Nảy: nhiều cỡ chữ nguyên, bật lần lượt — không dùng fontsize=expr
    if style == "pop":
        s = float(start or 0)
        e = float(end if end and end > s else s + 5)
        steps = (
            (0.70, s, s + 0.06),
            (0.88, s + 0.06, s + 0.11),
            (1.14, s + 0.11, s + 0.17),
            (1.00, s + 0.17, e),
        )
        stream = current_stream
        last = out
        for i, (mult, t0, t1) in enumerate(steps):
            last = f"{out}_p{i}"
            fs = max(1, int(round(float(font_size) * mult)))
            stream = _one(stream, last, fs, pos_x, pos_y, "", _enable_between(t0, t1))
        return last

    fs, x, y, fx = _hook_drawtext_fx(style, start, end, font_size, pos_x, pos_y, box_color)
    return _one(current_stream, out, fs, x, y, fx, enable or "")
def prepare_font_path_for_ffmpeg(font_path: str) -> str:
    if not font_path:
        return ""

    ffmpeg_path = str(Path(font_path).resolve()).replace("\\", "/")

    if ":" in ffmpeg_path:
        drive, rest = ffmpeg_path.split(":", 1)
        ffmpeg_path = f"{drive}\\:{rest}"

    return f"'{ffmpeg_path}'"


def ui_scale(value, video_width, video_height,
             base_width=1080, base_height=1920):
    scale = min(video_width / base_width, video_height / base_height)
    return value * scale
def extract_ffmpeg_error(log_output: str) -> str:
    """
    Trích xuất thông báo lỗi ngắn gọn từ output của ffmpeg.
    """
    lines = log_output.strip().splitlines()
    
    # Lấy tất cả các dòng có chứa từ khóa lỗi
    error_lines = [
        line.strip() for line in lines
        if re.search(r'error|no such file|invalid|failed|cannot', line, re.IGNORECASE)
    ]
    
    if error_lines:
        # Thường dòng lỗi cuối cùng là dòng tổng quát nhất, dễ hiểu nhất
        return error_lines[-1]
    
    return "Lỗi không xác định khi xử lý video"
def has_audio_stream(path) -> bool:
    """Kiểm tra file video có audio stream hay không, dùng ffprobe."""
    try:
        cmd = [
            str(FFPROBE_EXE),
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-select_streams", "a",
            str(path)
        ]
        result = run_hidden(cmd, capture_output=True, text=True, encoding="utf-8")
        data = json.loads(result.stdout)
        return bool(data.get("streams"))
    except Exception:
        return False
def crop_video(option: str, input_path: str, output_path: str, crop: dict,
                video_w: int = None, video_h: int = None) -> dict:
    try:
        output_dir = Path(output_path)
        output_dir.mkdir(parents=True, exist_ok=True)

        input_file = Path(input_path)
        output_file = output_dir / f"{input_file.stem}_crop{input_file.suffix}"

        x = round(crop["x"] * video_w)
        y = round(crop["y"] * video_h)
        w = round(crop["width"] * video_w)
        h = round(crop["height"] * video_h)

        x &= ~1
        y &= ~1
        w &= ~1
        h &= ~1

        if x + w > video_w:
            w = video_w - x
        if y + h > video_h:
            h = video_h - y

        w &= ~1
        h &= ~1

        profile = get_render_option(option)
        _safe_print(f"Render profile: {profile}")
        encoder = profile["encoder"]
        preset = profile["preset"]

        cmd = [
            str(FFMPEG_EXE),
            # "-threads", "2",
            "-y",
            "-i", input_path,
            "-vf", f"crop={w}:{h}:{x}:{y}",
            "-c:v", encoder,
            "-preset", preset,
            "-c:a", "copy",
            str(output_file)
        ]

        # dùng input_path làm key để stop_job(input_path) sau này
        _run(cmd, track_key=input_path)

        return {
            "success": True,
            "output": str(output_file),
            "message": "Crop video thành công."
        }

    except FFmpegError as e:
        return {
            "success": False,
            "message": str(e),
            "stopped": _stop_all_flag,   # để main.py biết đây là do bị stop hay lỗi thật
        }

    except Exception as e:
        return {
            "success": False,
            "message": str(e)
        }

def _even_dim(n):
    n = max(2, int(round(n)))
    return n if n % 2 == 0 else n - 1

def _probe_video_size(path: str):
    try:
        cmd = [
            str(FFPROBE_EXE),
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "json",
            str(path),
        ]
        result = run_hidden(cmd, capture_output=True, text=True, encoding="utf-8")
        streams = json.loads(result.stdout or "{}").get("streams") or []
        if streams:
            return int(streams[0].get("width") or 0), int(streams[0].get("height") or 0)
    except Exception:
        pass
    return 0, 0

def _crop_pixels(crop, video_w, video_h):
    x = _even_dim(crop["x"] * video_w)
    y = _even_dim(crop["y"] * video_h)
    w = _even_dim(crop["width"] * video_w)
    h = _even_dim(crop["height"] * video_h)
    if x + w > video_w:
        w = _even_dim(video_w - x)
    if y + h > video_h:
        h = _even_dim(video_h - y)
    return max(0, x), max(0, y), max(2, w), max(2, h)
def random_color_filter():
    hue = random.uniform(-15, 15)
    saturation = random.uniform(0.90, 1.15)
    brightness = random.uniform(-0.03, 0.03)
    contrast = random.uniform(0.95, 1.05)

    return (
        f"hue=h={hue:.2f}:s={saturation:.2f},"
        f"eq=brightness={brightness:.3f}:contrast={contrast:.3f}"
    )
def auto_create_crop_segments(
    input_path: str,
    crop_mode: str = "center",
    min_duration: float = 2.0,
    max_duration: float = 5.0,
    target_w: int = 720,
    target_h: int = 1280,
    video_w: int = None,
    video_h: int = None,
    apply_crop: bool = True
) -> list:
    """
    Tự động tạo danh sách crops cho crop_segments_concat().

    - Thời lượng mỗi đoạn được random từ min_duration -> max_duration.
    - Các đoạn chạy liên tục từ đầu đến cuối video.
    - crop_mode:
        "center" = crop giữa
        "random" = crop vị trí ngẫu nhiên

    Trả về dạng:
    [
        {
            "start": 0.0,
            "end": 3.42,
            "x": 0.0,
            "y": 0.0,
            "width": 0.5625,
            "height": 1.0
        },
        ...
    ]
    """

    try:
        # -----------------------------------------
        # Lấy kích thước video
        # -----------------------------------------
        if not video_w or not video_h:
            video_w, video_h = _probe_video_size(input_path)

        if not video_w or not video_h:
            return []

        # -----------------------------------------
        # Lấy thời lượng video
        # -----------------------------------------
        vid_dur = get_media_duration_seconds(input_path) or 0.0

        if vid_dur <= 0:
            return []

        # -----------------------------------------
        # Kiểm tra duration
        # -----------------------------------------
        min_duration = max(0.1, float(min_duration))
        max_duration = max(min_duration, float(max_duration))

        # -----------------------------------------
        # Tỷ lệ khung hình target
        # -----------------------------------------
        if apply_crop:
            target_ratio = float(target_w) / float(target_h)
            if float(video_w) / float(video_h) > target_ratio:
                crop_h = video_h
                crop_w = int(crop_h * target_ratio)
            else:
                crop_w = video_w
                crop_h = int(crop_w / target_ratio)
            crop_w = _even_dim(crop_w)
            crop_h = _even_dim(crop_h)
            crop_w = min(crop_w, _even_dim(video_w))
            crop_h = min(crop_h, _even_dim(video_h))
        else:
            crop_w = _even_dim(video_w)
            crop_h = _even_dim(video_h)

        # -----------------------------------------
        # Tạo segments
        # -----------------------------------------
        segments = []

        current_time = 0.0

        while current_time < vid_dur:

            # Random thời lượng
            duration = random.uniform(
                min_duration,
                max_duration
            )

            start = current_time
            end = min(
                start + duration,
                vid_dur
            )

            # Bỏ đoạn quá ngắn
            if end - start < 0.05:
                break

            if apply_crop:
                shrink = random.uniform(0.02, 0.05)
                seg_w = _even_dim(crop_w * (1.0 - shrink))
                seg_h = _even_dim(crop_h * (1.0 - shrink))
                seg_w = min(seg_w, crop_w)
                seg_h = min(seg_h, crop_h)
            else:
                seg_w = crop_w
                seg_h = crop_h

            # -------------------------------------
            # Tính vị trí crop
            # -------------------------------------
            max_x = max(0, video_w - seg_w)
            max_y = max(0, video_h - seg_h)

            if crop_mode == "random":

                x_pixel = random.randint(
                    0,
                    max_x
                )

                y_pixel = random.randint(
                    0,
                    max_y
                )

            else:
                # center
                x_pixel = max_x // 2
                y_pixel = max_y // 2

            # -------------------------------------
            # Đổi pixel -> giá trị 0.0 - 1.0
            #
            # Vì _crop_pixels() của bạn đang dùng:
            #
            # x * video_w
            # y * video_h
            # width * video_w
            # height * video_h
            # -------------------------------------
            x = x_pixel / float(video_w)
            y = y_pixel / float(video_h)

            width = seg_w / float(video_w)
            height = seg_h / float(video_h)

            segments.append({
                "start": round(start, 3),
                "end": round(end, 3),
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "flip": random.choice([True, False])
            })

            # Đoạn sau không dính sát đoạn trước: bỏ một khoảng ngắn rồi mới cắt tiếp.
            if crop_mode == "random":
                current_time = end + random.uniform(0.1, 0.4)
            else:
                current_time = end

        return segments

    except Exception:
        return []
def crop_segments_concat_wf(option: str, input_path: str, output_path: str,
                         video_w: int = None, video_h: int = None,
                         target_w: int = None, target_h: int = None,
                         crop_mode: str = "center",
                         min_duration: float = 2.0,
                         max_duration: float = 5.0,
                         use_color: bool = False,
                         use_volume: bool = False,
                         use_random_cut: bool = False,
                         use_crop: bool = False) -> dict:
    """Cắt từng đoạn theo start/end + khung crop, rồi nối thành 1 video."""
    script_path = None
    try:
        output_dir = Path(output_path)
        output_dir.mkdir(parents=True, exist_ok=True)

        input_file = Path(input_path)
        output_file = output_dir / f"{input_file.stem}_crop.mp4"

        if not video_w or not video_h:
            video_w, video_h = _probe_video_size(input_path)
        if not video_w or not video_h:
            return {"success": False, "message": "Không đọc được kích thước video."}

        if use_crop:
            tw_in = int(target_w or 1080)
            th_in = int(target_h or 1920)
        else:
            tw_in = int(video_w)
            th_in = int(video_h)
        vid_dur = get_media_duration_seconds(input_path) or 0.0
        seg_min = min_duration
        seg_max = max_duration
        seg_mode = "random" if use_random_cut else "center"
        if not use_random_cut:
            seg_min = vid_dur or 1
            seg_max = seg_min
        segments = []
        crops = auto_create_crop_segments(
            input_path=input_path,
            crop_mode=seg_mode,
            min_duration=seg_min,
            max_duration=seg_max,
            target_w=tw_in,
            target_h=th_in,
            video_w=video_w,
            video_h=video_h,
            apply_crop=use_crop,
        )
        for box in sorted(crops or [], key=lambda x: (x.get("start", 0), x.get("end", 0))):
            start = float(box.get("start", 0) or 0)
            end = _resolve_timed_end(box, vid_dur)
            if end - start <= 0.05:
                continue
            x, y, w, h = _crop_pixels(box, video_w, video_h)
            segments.append({"start": start, "end": end, "x": x, "y": y, "w": w, "h": h, "flip": box.get("flip", False)})

        if not segments:
            return {"success": False, "message": "Không có đoạn crop hợp lệ."}

        tw = _even_dim(tw_in)
        th = _even_dim(th_in)
        profile = get_render_option(option)
        encoder = profile["encoder"]
        preset = profile["preset"]
        has_audio = has_audio_stream(input_path)

        filter_parts = []
        concat_in = ""
        for i, seg in enumerate(segments):
            video_filter = (
                f"[0:v]trim=start={seg['start']}:end={seg['end']},setpts=PTS-STARTPTS,"
                f"crop={seg['w']}:{seg['h']}:{seg['x']}:{seg['y']},"
            )

            if seg.get("flip", False):
                video_filter += "hflip,"

            video_filter += (
                f"scale={tw}:{th}:force_original_aspect_ratio=increase,"
                f"crop={tw}:{th},setsar=1,format=yuv420p[v{i}]"
            )

            filter_parts.append(video_filter)
            if has_audio:
                filter_parts.append(
                    f"[0:a]atrim=start={seg['start']}:end={seg['end']},asetpts=PTS-STARTPTS[a{i}]"
                )
                concat_in += f"[v{i}][a{i}]"
            else:
                concat_in += f"[v{i}]"

        n = len(segments)
        if has_audio:
            filter_parts.append(f"{concat_in}concat=n={n}:v=1:a=1[outv][outa]")
        else:
            filter_parts.append(f"{concat_in}concat=n={n}:v=1:a=0[outv]")

        script_path = output_dir / f"{input_file.stem}_crop_filter.txt"
        script_path.write_text(";".join(filter_parts), encoding="utf-8")
        cmd = [
            str(FFMPEG_EXE),
            "-y",
            "-i", input_path,
            "-filter_complex_script", str(script_path),
            "-map", "[outv]",
            "-c:v", encoder,
            "-preset", preset,
        ]
        if has_audio:
            cmd.extend(["-map", "[outa]", "-c:a", "aac", "-b:a", "192k"])
        else:
            cmd.append("-an")

        if encoder == "h264_nvenc":
            cmd.extend(["-cq", str(profile.get("cq", 23))])
        else:
            cmd.extend(["-crf", str(profile.get("crf", 23))])

        cmd.extend(["-pix_fmt", "yuv420p", str(output_file)])
        _run(cmd, track_key=input_path)

        return {
            "success": True,
            "output": str(output_file),
            "message": "Crop video thành công."
        }

    except FFmpegError as e:
        return {
            "success": False,
            "message": str(e),
            "stopped": _stop_all_flag,
        }
    except Exception as e:
        return {
            "success": False,
            "message": str(e)
        }
    finally:
        if script_path is not None:
            try:
                script_path.unlink(missing_ok=True)
            except Exception:
                pass

def apply_color_wf(option: str, input_path: str, output_path: str) -> dict:
    """Luồng màu, tách khỏi crop. Random hue/saturation/brightness/contrast."""
    try:
        output_dir = Path(output_path)
        output_dir.mkdir(parents=True, exist_ok=True)
        src = Path(input_path)
        dest = output_dir / f"{src.stem}_color{src.suffix or '.mp4'}"

        profile = get_render_option(option)
        encoder = profile["encoder"]
        preset = profile["preset"]
        color_filter = random_color_filter()

        cmd = [
            str(FFMPEG_EXE),
            "-y",
            "-i", str(src),
            "-vf", color_filter,
            "-c:v", encoder,
            "-preset", preset,
        ]
        if encoder == "h264_nvenc":
            cmd.extend(["-cq", str(profile.get("cq", 23))])
        else:
            cmd.extend(["-crf", str(profile.get("crf", 23))])

        cmd.extend(["-c:a", "copy", "-pix_fmt", "yuv420p", str(dest)])

        _run(cmd, track_key=input_path)

        return {"success": True, "output": str(dest), "message": "Random màu sắc thành công."}

    except FFmpegError as e:
        return {"success": False, "message": str(e), "stopped": _stop_all_flag}
    except Exception as e:
        return {"success": False, "message": str(e)}


def apply_volume_wf(option: str, input_path: str, output_path: str) -> dict:
    """Luồng âm lượng, tách khỏi crop. Random tăng/giảm volume audio gốc."""
    try:
        output_dir = Path(output_path)
        output_dir.mkdir(parents=True, exist_ok=True)
        src = Path(input_path)
        dest = output_dir / f"{src.stem}_volume{src.suffix or '.mp4'}"

        if not has_audio_stream(src):
            shutil.copy2(src, dest)
            return {"success": True, "output": str(dest), "message": "Video không có audio, giữ nguyên."}

        volume_factor = round(random.uniform(0.75, 1.35), 3)

        cmd = [
            str(FFMPEG_EXE),
            "-y",
            "-i", str(src),
            "-af", f"volume={volume_factor}",
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            str(dest),
        ]

        _run(cmd, track_key=input_path)

        return {"success": True, "output": str(dest), "message": f"Random âm lượng thành công (x{volume_factor})."}

    except FFmpegError as e:
        return {"success": False, "message": str(e), "stopped": _stop_all_flag}
    except Exception as e:
        return {"success": False, "message": str(e)}
XFADE_EFFECTS = (
    "fade", "wipeleft", "wiperight", "wipeup", "wipedown",
    "slideleft", "slideright", "slideup", "slidedown",
    "circlecrop", "rectcrop", "distance", "fadeblack", "fadewhite", "radial",
    "smoothleft", "smoothright", "smoothup", "smoothdown",
    "circleopen", "circleclose", "vertopen", "vertclose", "horzopen", "horzclose",
    "dissolve", "pixelize", "diagtl", "diagtr", "diagbl", "diagbr",
    "hlslice", "hrslice", "vuslice", "vdslice", "hblur", "fadegrays",
    "wipetl", "wipetr", "wipebl", "wipebr", "squeezeh", "squeezev",
    "zoomin", "fadefast", "fadeslow",
    "hlwind", "hrwind", "vuwind", "vdwind",
    "coverleft", "coverright", "coverup", "coverdown",
    "revealleft", "revealright", "revealup", "revealdown",
)


def random_xfade_effect(rng, avoid=None):
    """Mỗi lần gọi lấy một hiệu ứng. rng riêng nên các luồng không trùng nhau."""
    pool = [name for name in XFADE_EFFECTS if name != avoid]
    if not pool:
        pool = list(XFADE_EFFECTS)
    return rng.choice(pool)


def _combo_filter_escape(text):
    out = []
    for ch in str(text or ""):
        if ch in "\\':,;[]%":
            out.append("\\" + ch)
        elif ch in "\r\n":
            out.append(" ")
        else:
            out.append(ch)
    return "".join(out).strip()


def render_combo_a(input_path, output_dir, text="", track_key=None):
    """Đoạn đầu theo video gốc. Mỗi ảnh thành video 4 giây, cắt đôi, chèn hiệu ứng giữa hai nửa."""
    work = None
    try:
        if _stop_all_flag:
            return {"success": False, "stopped": True, "message": "Đã dừng trước khi xử lý."}
        src = Path(input_path)
        if not src.is_file():
            return {"success": False, "message": "Không thấy file video."}
        out_dir = Path(output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix="combo_a_", dir=str(out_dir)))
        duration = get_media_duration_seconds(str(src)) or 0.0
        if duration < 1.0:
            return {"success": False, "message": "Video ngắn hơn 1 giây, không render Combo mở đầu."}

        rng = random.Random()
        ratio = rng.uniform(0.38, 0.40)
        part_len = duration * ratio
        if part_len <= 1.05:
            return {"success": False, "message": "Video quá ngắn để chèn chuyển cảnh."}
        frame2 = 11.2 if duration > 11.4 else max(0.0, duration - 0.08)
        wave = (
            "lum='lum(X+if(between(T\\,1.24\\,1.44)\\,8*sin(PI*(T-1.24)/0.2)\\,0)*sin(2*PI*Y/24+T*30)\\,Y)'"
            ":cb='cb(X+if(between(T\\,1.24\\,1.44)\\,14*sin(PI*(T-1.24)/0.2)\\,0)*sin(2*PI*Y/24+T*30)\\,Y)'"
            ":cr='cr(X+if(between(T\\,1.24\\,1.44)\\,2*sin(PI*(T-1.24)/0.2)\\,0)*sin(2*PI*Y/24+T*30)\\,Y)'"
        )
        vf = (
            "scale=iw*1.11:ih*1.11,crop=576:768:32:184,fps=25,format=yuv444p,geq="
            + wave
            + ",format=yuv420p,fade=t=in:st=0:d=0.5"
        )
        label = _combo_filter_escape(text)
        if label:
            font = Path(os.environ.get("WINDIR") or "C:/Windows") / "Fonts" / "arial.ttf"
            if not font.is_file():
                return {"success": False, "message": "Không thấy font Arial để ghi chữ mở đầu."}
            font_esc = str(font).replace("\\", "/").replace(":", "\\:")
            vf += (
                ",drawtext=fontfile='" + font_esc + "'"
                ":text='" + label + "'"
                ":fontcolor=white:fontsize=28:x=(w-text_w)/2:y=h*0.32"
            )
        part1 = work / "part1.mp4"
        _run([
            str(FFMPEG_EXE), "-y", "-i", str(src), "-t", f"{part_len:.3f}",
            "-vf", vf, "-an", "-c:v", "libx264", "-crf", "20", "-r", "25", str(part1),
        ], track_key=track_key)
        if _stop_all_flag:
            return {"success": False, "stopped": True, "message": "Đã dừng."}

        frames = (0.0, frame2)
        zooms = (
            "zoompan=z='if(eq(on,0),1.08,zoom+0.0006)':x='iw/2-(iw/zoom/2)+12*sin(on/5)':y='ih/2-(ih/zoom/2)+7*cos(on/6)':d=100:s=576x768:fps=25",
            "zoompan=z='if(eq(on,0),1.08,zoom+0.0006)':x='iw/2-(iw/zoom/2)+10*sin(on/4)':y='ih/2-(ih/zoom/2)+8*cos(on/7)':d=100:s=576x768:fps=25",
        )
        clips = []
        for index, (at, zoom) in enumerate(zip(frames, zooms), start=1):
            if _stop_all_flag:
                return {"success": False, "stopped": True, "message": "Đã dừng."}
            jpg = work / f"f{index}.jpg"
            clip = work / f"c{index}.mp4"
            _run([
                str(FFMPEG_EXE), "-y", "-ss", f"{at:.3f}", "-i", str(src),
                "-frames:v", "1", "-update", "1", str(jpg),
            ], track_key=track_key)
            _run([
                str(FFMPEG_EXE), "-y", "-loop", "1", "-i", str(jpg),
                "-vf", "scale=iw*1.11:ih*1.11,crop=576:768:32:184,scale=1152:1536," + zoom + ",format=yuv420p",
                "-frames:v", "100", "-an", "-c:v", "libx264", "-crf", "20", "-r", "25", str(clip),
            ], track_key=track_key)
            half = 2.0
            for piece, start in enumerate((0, 2)):
                part = work / f"p{index}_{piece}.mp4"
                _run([
                    str(FFMPEG_EXE), "-y", "-ss", str(start), "-i", str(clip),
                    "-t", str(int(half)), "-an", "-c:v", "libx264", "-crf", "20", "-r", "25", str(part),
                ], track_key=track_key)
                clips.append(part)

        part1_len = get_media_duration_seconds(str(part1)) or part_len
        fade = 1.0
        half = 2.0
        if part1_len <= fade:
            return {"success": False, "message": "Đoạn ghép ngắn hơn thời gian chuyển cảnh."}
        lengths = [part1_len] + [half] * len(clips)
        inputs = [part1] + clips
        offset = lengths[0] - fade
        prev = "[0:v]"
        chain = []
        used = []
        last_effect = None
        for index in range(1, len(inputs)):
            effect = random_xfade_effect(rng, avoid=last_effect)
            last_effect = effect
            used.append(effect)
            label_out = "[v]" if index == len(inputs) - 1 else "[v" + str(index) + "]"
            chain.append(
                prev + "[" + str(index) + ":v]xfade=transition=" + effect + ":duration="
                + format(fade, ".1f") + ":offset=" + format(offset, ".3f") + label_out
            )
            prev = label_out
            offset += lengths[index] - fade
        final_tmp = work / "out.mp4"
        cmd = [str(FFMPEG_EXE), "-y"]
        for item in inputs:
            cmd.extend(["-i", str(item)])
        cmd.extend([
            "-filter_complex", ";".join(chain),
            "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "20", "-r", "25",
            str(final_tmp),
        ])
        _run(cmd, track_key=track_key)
        dest = out_dir / (src.stem + ".mp4")
        if dest.exists():
            dest.unlink()
        shutil.move(str(final_tmp), str(dest))
        return {
            "success": True,
            "output": str(dest),
            "message": "Combo mở đầu. Chuyển cảnh: " + " · ".join(used) + ".",
        }
    except FFmpegError as exc:
        return {"success": False, "message": str(exc), "stopped": _stop_all_flag}
    except Exception as exc:
        return {"success": False, "message": str(exc), "stopped": is_stopping()}
    finally:
        if work is not None and work.exists():
            shutil.rmtree(work, ignore_errors=True)


def render_highlight_clip(input_path, output_dir, source_url="", seconds=60, track_key=None, on_log=None, on_progress=None, use_volume=False, use_two_screen=False, score=0.5, on_part=None):
    """Cắt từng đoạn hay ra một file riêng, tên có part để không ghi đè nhau."""
    tmp = None

    def _log(text):
        if on_log is None:
            return
        try:
            on_log(str(text))
        except Exception:
            pass

    def _progress(percent, label):
        if on_progress is None:
            return
        try:
            on_progress(int(percent), str(label))
        except Exception:
            pass

    try:
        if _stop_all_flag:
            return {"success": False, "stopped": True, "message": "Đã dừng trước khi xử lý."}
        src = Path(input_path)
        if not src.is_file():
            return {"success": False, "message": "Không thấy file video."}
        url = str(source_url or "").strip()
        if not url:
            return {"success": False, "message": "Không có link YouTube để lấy đoạn hay."}
        try:
            seconds = int(seconds)
        except (TypeError, ValueError):
            seconds = 60
        seconds = max(1, min(600, seconds))

        import check_video
        from downloader import user_exe_dir

        cookie = user_exe_dir() / "cookies" / "youtube.txt"
        _log("Đang lấy danh sách đoạn hay: " + src.name)
        heatmap = check_video.get_heatmap(
            url,
            cookie_file=cookie if cookie.is_file() else check_video.COOKIE_FILE,
        )
        clips = check_video.merged_highlights(heatmap)
        if not clips:
            return {"success": False, "message": "Không có heatmap cho video này."}
        try:
            score = float(score)
        except (TypeError, ValueError):
            score = 0.5
        score = max(0.1, min(1.0, int(score * 10 + 0.5) / 10))

        def _point(value):
            return int(float(value or 0) * 10 + 0.5) / 10

        listed = ", ".join("{:.1f}".format(_point(item.get("value"))) for item in clips)
        kept = [item for item in clips if _point(item.get("value")) >= score]
        _log("Đoạn hay: {0} đoạn, điểm {1}. Giữ điểm >= {2:.1f}: {3} đoạn.".format(
            len(clips), listed, score, len(kept),
        ))
        if not kept:
            return {"success": False, "message": "Không có đoạn hay nào có số điểm >= {0:.1f}. Các điểm đang có: {1}.".format(score, listed)}
        clips = kept

        pieces = []
        for item in clips:
            start = max(0.0, float(item["start"]))
            end = max(start, float(item["end"]))
            value = float(item.get("value") or 0)
            cursor = start
            while cursor + seconds <= end + 0.05:
                pieces.append({
                    "start": cursor,
                    "end": cursor + float(seconds),
                    "cut": float(seconds),
                    "value": value,
                })
                cursor += float(seconds)
            if cursor == start and end - start >= 1.0:
                pieces.append({
                    "start": start,
                    "end": end,
                    "cut": end - start,
                    "value": value,
                })
        if not pieces:
            return {"success": False, "message": "Đoạn hay ngắn hơn 1 giây."}
        total = len(pieces)
        _log("Cắt {0} part, mỗi part {1:.0f} giây: {2}".format(total, float(seconds), src.name))
        if use_two_screen:
            _log("Render 2 màn hình: khung 9:16, video ở giữa, viền trên và dưới phóng to rồi làm mờ.")

        out_dir = Path(output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        outputs = []
        for index, piece in enumerate(pieces, start=1):
            if _stop_all_flag:
                return {"success": False, "stopped": True, "message": "Đã dừng."}
            dest = out_dir / "{0}_part{1}.mp4".format(src.stem, index)
            tmp = out_dir / "{0}_part{1}._hl.mp4".format(src.stem, index)
            if tmp.exists():
                tmp.unlink()
            label = "Đang render Part {0}/{1} của {2} ({3} -> {4})".format(
                index,
                total,
                src.name,
                check_video.fmt_time(piece["start"]),
                check_video.fmt_time(piece["end"]),
            )

            def _tick(part_percent, _index=index, _label=label):
                part_percent = max(0, min(100, int(part_percent)))
                overall = int(((_index - 1) * 100 + part_percent) / total)
                _progress(overall, "{0} — {1}% · tổng {2}%".format(_label, part_percent, overall))

            _tick(0)
            cmd = [
                str(FFMPEG_EXE), "-y",
                "-ss", f"{piece['start']:.3f}",
                "-i", str(src),
                "-t", f"{piece['cut']:.3f}",
            ]
            if use_two_screen:
                cmd.extend([
                    "-filter_complex",
                    "[0:v]split=2[fg][bg];"
                    "[bg]scale=1080:1920:force_original_aspect_ratio=increase,"
                    "scale=trunc(iw*5/4/2)*2:trunc(ih*5/4/2)*2,"
                    "crop=1080:1920,gblur=sigma=28,format=yuv420p[bg];"
                    "[fg]scale=1080:1920:force_original_aspect_ratio=decrease,"
                    "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p[fg];"
                    "[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[vout]",
                    "-map", "[vout]",
                    "-map", "0:a:0?",
                ])
            else:
                cmd.extend([
                    "-map", "0:v:0",
                    "-map", "0:a:0?",
                ])
            cmd.extend([
                "-c:v", "libx264", "-crf", "20", "-preset", "fast",
                "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart",
                str(tmp),
            ])
            _runProgress(cmd, track_key=track_key, duration_seconds=float(piece["cut"]), on_progress=_tick, out_video=str(tmp))
            if use_volume:
                vol = apply_volume_wf("", str(tmp), str(out_dir))
                if not vol.get("success"):
                    return {
                        "success": False,
                        "message": str(vol.get("message") or "Đổi âm lượng lỗi"),
                        "stopped": vol.get("stopped"),
                    }
                produced = Path(str(vol.get("output") or ""))
                if dest.exists():
                    dest.unlink()
                produced.replace(dest)
                if tmp.exists():
                    tmp.unlink()
                tmp = None
                if vol.get("message"):
                    _log("Part {0}/{1}: {2}".format(index, total, vol.get("message")))
            else:
                if dest.exists():
                    dest.unlink()
                tmp.replace(dest)
                tmp = None
            outputs.append(str(dest))
            if on_part is not None:
                try:
                    on_part(str(dest))
                except Exception:
                    pass
            done = int(index * 100 / total)
            _progress(done, "Xong Part {0}/{1}: {2} — tổng {3}%".format(index, total, dest.name, done))
            _log("Xong Part {0}/{1}: {2}".format(index, total, dest.name))

        listing = " ; ".join(
            "{0} -> {1} | value = {2:.3f}".format(
                check_video.fmt_time(piece["start"]),
                check_video.fmt_time(piece["end"]),
                piece["value"],
            )
            for piece in pieces
        )
        names = " · ".join(Path(path).name for path in outputs)
        return {
            "success": True,
            "output": outputs[0],
            "outputs": outputs,
            "message": "Đoạn hay: " + listing + ". Đã lưu {0} file: {1}.".format(len(outputs), names),
        }
    except FFmpegError as exc:
        return {"success": False, "message": str(exc), "stopped": _stop_all_flag}
    except Exception as exc:
        return {"success": False, "message": str(exc), "stopped": is_stopping()}
    finally:
        if tmp is not None and tmp.exists():
            try:
                tmp.unlink()
            except Exception:
                pass


def process_video_pipeline_wf(
    option: str,
    input_path: str,
    output_path: str,
    use_crop: bool = False,
    use_random_cut: bool = False,
    use_color: bool = False,
    use_volume: bool = False,
    video_w: int = None,
    video_h: int = None,
    target_w: int = None,
    target_h: int = None,
    crop_mode: str = "center",
    min_duration: float = 2.0,
    max_duration: float = 5.0,
) -> dict:
    """
    Chạy tuần tự các bước được bật, output bước trước làm input bước sau.
    Thứ tự: Crop/RandomCut -> Color -> Volume.
    File trung gian (nếu có nhiều hơn 1 bước) sẽ bị xoá sau khi xong,
    chỉ giữ lại file kết quả cuối cùng.
    """
    tmp_dir = None
    current_input = input_path
    intermediate_files = []
    try:
        if _stop_all_flag:
            return {"success": False, "stopped": True, "message": "Đã dừng trước khi xử lý."}

        # Nếu có nhiều hơn 1 bước -> dùng thư mục tạm cho các bước trung gian
        steps_enabled = sum([bool(use_crop or use_random_cut), bool(use_color), bool(use_volume)])
        use_tmp = steps_enabled > 1
        if use_tmp:
            tmp_dir = Path(tempfile.mkdtemp(prefix="rs_pipeline_"))

        def _step_output_dir():
            return str(tmp_dir) if use_tmp else str(output_path)

        # ----- Bước 1: Crop / Random cut -----
        if use_crop or use_random_cut:
            result = crop_segments_concat_wf(
                option=option,
                input_path=current_input,
                output_path=_step_output_dir(),
                video_w=video_w,
                video_h=video_h,
                target_w=target_w,
                target_h=target_h,
                crop_mode=crop_mode,
                min_duration=min_duration,
                max_duration=max_duration,
                use_random_cut=use_random_cut,
                use_crop=use_crop,
            )
            if not result.get("success"):
                return result
            current_input = result["output"]
            if use_tmp:
                intermediate_files.append(current_input)

        if _stop_all_flag:
            return {"success": False, "stopped": True, "message": "Đã dừng."}

        # ----- Bước 2: Random màu -----
        if use_color:
            result = apply_color_wf(option, current_input, _step_output_dir())
            if not result.get("success"):
                return result
            current_input = result["output"]
            if use_tmp:
                intermediate_files.append(current_input)

        if _stop_all_flag:
            return {"success": False, "stopped": True, "message": "Đã dừng."}

        # ----- Bước 3: Random âm lượng -----
        if use_volume:
            result = apply_volume_wf(option, current_input, _step_output_dir())
            if not result.get("success"):
                return result
            current_input = result["output"]
            if use_tmp:
                intermediate_files.append(current_input)

        # Nếu không bật option nào cả -> copy nguyên input sang output
        if not (use_crop or use_random_cut or use_color or use_volume):
            output_dir = Path(output_path)
            output_dir.mkdir(parents=True, exist_ok=True)
            src = Path(input_path)
            dest = output_dir / f"{src.stem}_out{src.suffix or '.mp4'}"
            shutil.copy2(src, dest)
            return {"success": True, "output": str(dest), "message": "Không có option nào được bật, giữ nguyên video."}

        # ----- Chuyển file kết quả cuối cùng ra thư mục output thật -----
        final_dir = Path(output_path)
        final_dir.mkdir(parents=True, exist_ok=True)
        final_out = final_dir / Path(input_path).name

        if Path(current_input).resolve() != final_out.resolve():
            if final_out.exists():
                final_out.unlink()
            shutil.move(str(current_input), str(final_out))
            # File vừa move ra khỏi tmp_dir thì không cần xoá lại nữa
            if str(current_input) in intermediate_files:
                intermediate_files.remove(current_input)

        return {"success": True, "output": str(final_out), "message": "Xử lý video thành công."}

    except Exception as e:
        return {"success": False, "message": str(e)}
    finally:
        # Dọn file trung gian trong thư mục tạm
        if tmp_dir and Path(tmp_dir).exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)
def crop_segments_concat(option: str, input_path: str, output_path: str, crops: list,
                         video_w: int = None, video_h: int = None,
                         target_w: int = None, target_h: int = None,
                         use_source_size: bool = False) -> dict:
    """Cắt từng đoạn theo start/end + khung crop, rồi nối thành 1 video."""
    try:
        output_dir = Path(output_path)
        output_dir.mkdir(parents=True, exist_ok=True)

        input_file = Path(input_path)
        output_file = output_dir / f"{input_file.stem}_crop.mp4"

        if not video_w or not video_h:
            video_w, video_h = _probe_video_size(input_path)
        if not video_w or not video_h:
            return {"success": False, "message": "Không đọc được kích thước video."}

        vid_dur = get_media_duration_seconds(input_path) or 0.0
        segments = []
        for box in sorted(crops or [], key=lambda x: (x.get("start", 0), x.get("end", 0))):
            start = float(box.get("start", 0) or 0)
            end = _resolve_timed_end(box, vid_dur)
            if end - start <= 0.05:
                continue
            x, y, w, h = _crop_pixels(box, video_w, video_h)
            segments.append({"start": start, "end": end, "x": x, "y": y, "w": w, "h": h})

        if not segments:
            return {"success": False, "message": "Không có đoạn crop hợp lệ."}

        if use_source_size:
            tw = _even_dim(segments[0]["w"])
            th = _even_dim(segments[0]["h"])
        else:
            tw = _even_dim(target_w or segments[0]["w"])
            th = _even_dim(target_h or segments[0]["h"])
        profile = get_render_option(option)
        encoder = profile["encoder"]
        preset = profile["preset"]
        has_audio = has_audio_stream(input_path)

        filter_parts = []
        concat_in = ""
        for i, seg in enumerate(segments):
            fit = ""
            if seg["w"] != tw or seg["h"] != th:
                fit = (
                    f"scale={tw}:{th}:force_original_aspect_ratio=decrease,"
                    f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2,"
                )
            filter_parts.append(
                f"[0:v]trim=start={seg['start']}:end={seg['end']},setpts=PTS-STARTPTS,"
                f"crop={seg['w']}:{seg['h']}:{seg['x']}:{seg['y']},"
                f"{fit}setsar=1,format=yuv420p[v{i}]"
            )
            if has_audio:
                filter_parts.append(
                    f"[0:a]atrim=start={seg['start']}:end={seg['end']},asetpts=PTS-STARTPTS[a{i}]"
                )
                concat_in += f"[v{i}][a{i}]"
            else:
                concat_in += f"[v{i}]"

        n = len(segments)
        if has_audio:
            filter_parts.append(f"{concat_in}concat=n={n}:v=1:a=1[outv][outa]")
        else:
            filter_parts.append(f"{concat_in}concat=n={n}:v=1:a=0[outv]")

        cmd = [
            str(FFMPEG_EXE),
            "-y",
            "-i", input_path,
            "-filter_complex", ";".join(filter_parts),
            "-map", "[outv]",
            "-c:v", encoder,
            "-preset", preset,
        ]
        if has_audio:
            cmd.extend(["-map", "[outa]", "-c:a", "aac", "-b:a", "192k"])
        else:
            cmd.append("-an")

        if encoder == "h264_nvenc":
            cmd.extend(["-cq", str(profile.get("cq", 23))])
        else:
            cmd.extend(["-crf", str(profile.get("crf", 23))])

        cmd.extend(["-pix_fmt", "yuv420p", str(output_file)])
        _run(cmd, track_key=input_path)

        return {
            "success": True,
            "output": str(output_file),
            "message": "Crop video thành công."
        }

    except FFmpegError as e:
        return {
            "success": False,
            "message": str(e),
            "stopped": _stop_all_flag,
        }
    except Exception as e:
        return {
            "success": False,
            "message": str(e)
        }

def export_image(option: str, input_path: str, output_path: str) -> dict:
    try:
        output_dir = Path(output_path)
        output_dir.mkdir(parents=True, exist_ok=True)

        input_file = Path(input_path)
        output_file = output_dir / f"{input_file.stem}_%05d.png"
        # profile = get_render_option(option)
        # encoder = profile["encoder"]
        # preset = profile["preset"]

        cmd = [
            str(FFMPEG_EXE),
            "-y",
            "-i", input_path,
            "-vf", "fps=1,scale=iw*2:ih*2:flags=lanczos",
            "-q:v", "1",
            str(output_file)
        ]

        # dùng input_path làm key để stop_job(input_path) sau này
        _run(cmd, track_key=input_path)

        return {
            "success": True,
            "output": str(output_dir),
            "message": "Xuất hình ảnh thành công."
        }

    except FFmpegError as e:
        return {
            "success": False,
            "message": str(e),
            "stopped": _stop_all_flag,   # để main.py biết đây là do bị stop hay lỗi thật
        }

    except Exception as e:
        return {
            "success": False,
            "message": str(e)
        }
def export_audio(option: str, input_path: str, output_path: str) -> dict:
    try:
        output_dir = Path(output_path)
        output_dir.mkdir(parents=True, exist_ok=True)

        input_file = Path(input_path)
        out_audio = output_dir / f"{input_file.stem}.mp3"
        # profile = get_render_option(option)
        # encoder = profile["encoder"]
        # preset = profile["preset"]

        cmd = [
            str(FFMPEG_EXE),
            "-y",
            "-i", str(input_file),
            "-vn",
            "-acodec", "mp3",
            str(out_audio)
        ]

        # dùng input_path làm key để stop_job(input_path) sau này
        _run(cmd, track_key=input_path)

        return {
            "success": True,
            "output": str(out_audio),
            "message": "Xuất audio thành công."
        }

    except FFmpegError as e:
        return {
            "success": False,
            "message": str(e),
            "stopped": _stop_all_flag,   # để main.py biết đây là do bị stop hay lỗi thật
        }

    except Exception as e:
        return {
            "success": False,
            "message": str(e)
        }
EFFECTS = [
    "center_zoom_in",
    "left_zoom_in",
    "right_zoom_in",
    "top_zoom_in",
    "bottom_zoom_in",
    "zoom_out"
]
def build_random_zoom_filter(effect: str, width: int, height: int) -> str:
    positions = {
        "center_zoom_in": ("1+0.3*on/180", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
        "left_zoom_in": ("1+0.3*on/180", "0", "ih/2-(ih/zoom/2)"),
        "right_zoom_in": ("1+0.3*on/180", "iw-iw/zoom", "ih/2-(ih/zoom/2)"),
        "top_zoom_in": ("1+0.3*on/180", "iw/2-(iw/zoom/2)", "0"),
        "bottom_zoom_in": ("1+0.3*on/180", "iw/2-(iw/zoom/2)", "ih-ih/zoom"),
        "zoom_out": ("1.3-0.3*on/180", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
    }

    zoom, x, y = positions.get(
        effect,
        ("1+0.3*on/180", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)")
    )

    return (
        f"zoompan=z='{zoom}':"
        f"x='{x}':"
        f"y='{y}':"
        f"d=180:s={width}x{height}:fps=60"
    )
def build_image_to_video_args(
    input_path: str,
    output_path: str,
    time: float,
    selected_option,
    filter: str = ""
):
    cmd = [
        str(FFMPEG_EXE),
        "-loop", "1",
        "-i", input_path,
    ]

    if filter:
        cmd.extend([
            "-vf", filter
        ])

    cmd.extend([
        "-t", str(time),
        "-r", "60"
    ])

    if selected_option["encoder"] == "h264_nvenc":
        cmd.extend([
            "-c:v", selected_option["encoder"],
            "-preset", selected_option["preset"],
            "-cq", str(selected_option["cq"]),
        ])
    else:
        cmd.extend([
            "-c:v", "libx264",
            "-crf", "23",
            "-preset", "fast",
        ])

    cmd.extend([
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-y",
        output_path
    ])

    return cmd            
def image_to_video(__windown,option: str,width:int, height:int ,input_path: str, output_path: str, time:float,pandhand:True,hold_seconds:float) -> dict:
    try:
        output_dir = Path(output_path)
        output_dir.mkdir(parents=True, exist_ok=True)

        input_image = Path(input_path)
        out_video = output_dir / f"{input_image.stem}.mp4"
        profile = get_render_option(option)
        effect = random.choice(EFFECTS)
        if not pandhand:
            filter = build_random_zoom_filter(effect, width, height)
            cmd = build_image_to_video_args(
                input_path,
                out_video,
                time,
                profile,
                filter
            )
            _run(cmd, track_key=input_path);
        else:

            sketch_effect.build_sketch_video(
                __windown,
                option,
                input_path,
                width,
                height,
                str(FFMPEG_EXE),
                input_image, 
                out_video,
                hand_png_path="hand.png",
                tip=(5,5),
                hand_width=140,
                duration_seconds=time,                
                hold_seconds=hold_seconds, 
                )

        return {
            "success": True,
            "output": str(out_video),
            "message": "Tạo video thành công."
        }

        #
# def build_sketch_video(option,ffmpeg,input_image, output_path, hand_png_path=None, tip=None, hand_width=140,
#                         duration_seconds=None, hold_seconds=HOLD_SECONDS):
#     src = cv2.imread(input_image)

    except FFmpegError as e:
        return {
            "success": False,
            "message": str(e),
            "stopped": _stop_all_flag,   # để main.py biết đây là do bị stop hay lỗi thật
        }

    except Exception as e:
        return {
            "success": False,
            "message": str(e)
        }
def _trim_one(seg, input_media,selected_option):
    cmd = [
        str(FFMPEG_EXE),
        "-y",
        "-ss", str(seg["start"]),
        "-t", str(seg["duration"]),
        "-i", str(input_media),
    ]

    if selected_option["encoder"] == "h264_nvenc":
        cmd.extend([
            "-c:v", selected_option["encoder"],
            "-preset", selected_option["preset"],
            "-cq", str(selected_option["cq"]),
        ])
    else:
        cmd.extend([
            "-c:v", "libx264",
            "-crf", "23",
            "-preset", "fast",
        ])

    cmd.extend([
        "-c:a", "aac",
        seg["output"]
    ])

    _run(cmd, track_key=input_media);

    return seg["output"]        
def trim_video_(__windown,option: str,threads:int,input_media:str,segments:dict) -> dict:
    try:
        profile = get_render_option(option)

        # max_workers = min(0, theads)   # hoặc cấu hình theo CPU
        __windown.evaluate_js(
            f'updateMediaStatus({json.dumps(input_media)}, "Đang cắt thành {len(segments)} đoạn", "processing")'
        )  
        with ThreadPoolExecutor(max_workers=threads) as executor:

            futures = [
                executor.submit(_trim_one, seg, input_media,profile)
                for seg in segments
            ]

            for future in as_completed(futures):
                future.result()     # nếu FFmpeg lỗi sẽ throw tại đây

        return {
            "success": True,
            "output": "",
            "message": "Trim video thành công."
        }

    except FFmpegError as e:
        return {
            "success": False,
            "message": str(e),
            "stopped": _stop_all_flag,
        }

    except Exception as e:
        return {
            "success": False,
            "message": str(e)
        } 

#FIX

def build_original_audio_filters(volume: float, tempo: float, pitch: float):
    """
    Áp dụng volume / tempo / pitch cho audio gốc (input 0:a).
    - pitch != 1.0 -> đổi cao độ bằng asetrate, đồng thời bù lại tempo
      (tempo mong muốn / pitch) để không đổi tốc độ ngoài ý muốn.
    - pitch == 1.0 nhưng tempo != 1.0 -> chỉ đổi tốc độ, giữ nguyên cao độ (atempo).
    Trả về (list các dòng filter, tên label cuối cùng).
    """
    filters = []
    current = "0:a"
    step = 0
 
    def new_out():
        nonlocal step
        step += 1
        return f"a_orig{step}"
 
    volume = volume if volume else 1.0
    tempo = tempo if tempo else 1.0
    pitch = pitch if pitch else 1.0
 
    if abs(pitch - 1.0) > 1e-3:
        combined_tempo = tempo / pitch
        combined_tempo = max(0.5, min(2.0, combined_tempo))
        out = new_out()
        filters.append(
            f"[{current}]asetrate=44100*{pitch},atempo={combined_tempo},aresample=44100[{out}]"
        )
        current = out
    elif abs(tempo - 1.0) > 1e-3:
        t = max(0.5, min(2.0, tempo))
        out = new_out()
        filters.append(f"[{current}]atempo={t}[{out}]")
        current = out
 
    if abs(volume - 1.0) > 1e-3:
        out = new_out()
        filters.append(f"[{current}]volume={volume}[{out}]")
        current = out
 
    if not filters:
        # Không có thay đổi nào -> vẫn cần 1 label rõ ràng để map/mix ở bước sau
        out = new_out()
        filters.append(f"[{current}]anull[{out}]")
        current = out
 
    return filters, current
 
 
def build_extra_audio_filters(input_index, volume: float, fade_in: float,
                               fade_out: float, duration_video: float, label_prefix: str):
    """
    Filter dùng chung cho audio "thêm vào" (audio thay thế từ files hoặc bg audio):
    - cắt đúng độ dài video
    - áp volume
    - fade in/out
 
    label_prefix dùng để tránh trùng tên label khi có 2 nguồn audio phụ
    (audio thay thế + bg audio) cùng chạy trong 1 filter_complex.
    """
    filters = []
    current = f"{input_index}:a"
    step = 0
 
    def new_out():
        nonlocal step
        step += 1
        return f"{label_prefix}{step}"
 
    volume = volume if volume else 1.0
    fade_in = fade_in or 0
    fade_out = fade_out or 0
 
    out = new_out()
    filters.append(f"[{current}]atrim=0:{duration_video},asetpts=PTS-STARTPTS[{out}]")
    current = out
 
    if abs(volume - 1.0) > 1e-3:
        out = new_out()
        filters.append(f"[{current}]volume={volume}[{out}]")
        current = out
 
    if fade_in > 0:
        out = new_out()
        filters.append(f"[{current}]afade=t=in:st=0:d={fade_in}[{out}]")
        current = out
 
    if fade_out > 0:
        start_fade_out = max(0, duration_video - fade_out)
        out = new_out()
        filters.append(f"[{current}]afade=t=out:st={start_fade_out}:d={fade_out}[{out}]")
        current = out
 
    return filters, current
 
 
# Giữ lại tên cũ để không phá tương thích, nếu chỗ khác trong code đang gọi build_bg_audio_filters
def build_bg_audio_filters(bg_input_index: int, volume: float, fade_in: float,
                            fade_out: float, duration_video: float):
    return build_extra_audio_filters(bg_input_index, volume, fade_in, fade_out, duration_video, "a_bg")
 
 
def build_audio_filters(has_audio: bool, should_mute: bool, audio_config: dict,
                         audio_file_index, bg_audio_index, duration_video: float):
    """
    2 phần âm thanh độc lập:
 
    PHẦN 1 - audio "chính":
      - Nếu KHÔNG mute và video có audio gốc -> dùng audio gốc (volume/tempo/pitch).
      - Nếu mute audio gốc VÀ có audio_file_index (đã chọn 1 file trong `files`)
        -> dùng file đó làm audio chính, thay thế cho audio gốc.
      - Nếu không thoả điều kiện nào -> không có audio chính.
 
    PHẦN 2 - bg audio (luôn cộng thêm nếu bật, độc lập với phần 1):
      - Nếu có bg_audio_index -> lấy filter (trim/volume/fade) rồi mix
        (amix) lên trên audio chính ở trên (nếu có).
 
    Trả về (list filter, tên label cuối) hoặc (list rỗng, None) nếu output không có audio.
    """
    filters = []
    main_label = None
    bg_label = None
 
    # ----- Phần 1: audio chính (gốc hoặc thay thế từ file khi mute) -----
    if not should_mute and has_audio:
        volume = audio_config.get("volumeOriginalAudio", 1.0)
        tempo = audio_config.get("tempoOriginalAudio", 1.0)
        pitch = audio_config.get("pitchOriginalAudio", 1.0)
        f, main_label = build_original_audio_filters(volume, tempo, pitch)
        filters.extend(f)
    elif should_mute and audio_file_index is not None:
        volume = audio_config.get("volumeOriginalAudio", 1.0)
        fade_in = audio_config.get("fadeInAudioFile", 0)
        fade_out = audio_config.get("fadeOutAudioFile", 0)
        f, main_label = build_extra_audio_filters(
            audio_file_index, volume, fade_in, fade_out, duration_video, "a_file"
        )
        filters.extend(f)
 
    # ----- Phần 2: bg audio (luôn cộng thêm nếu có, độc lập với phần 1) -----
    if bg_audio_index is not None:
        volume_bg = audio_config.get("volumeBgAudio", 1.0)
        fade_in_bg = audio_config.get("fadeInBgAudio", 0)
        fade_out_bg = audio_config.get("fadeOutBgAudio", 0)
        f, bg_label = build_extra_audio_filters(
            bg_audio_index, volume_bg, fade_in_bg, fade_out_bg, duration_video, "a_bg"
        )
        filters.extend(f)
 
    if main_label and bg_label:
        filters.append(
            f"[{main_label}][{bg_label}]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]"
        )
        return filters, "aout"
    elif main_label:
        return filters, main_label
    elif bg_label:
        return filters, bg_label
    else:
        return filters, None
def get_media_duration_seconds(path: str) -> float:
    """
    Lấy độ dài (giây) của 1 file media (audio/video) bằng ffprobe.
    Trả về 0.0 nếu không đọc được.
    """
    try:
        cmd = [
            str(FFPROBE_EXE),
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path)
        ]
        result = run_hidden(cmd, capture_output=True, text=True, encoding="utf-8")
        return float(result.stdout.strip())
    except Exception:
        return 0.0


def _resolve_timed_end(layer, duration_video):
    """Kết thúc layer: theo thời gian video nếu bật follow, không vượt duration."""
    data = layer.get("data") if isinstance(layer.get("data"), dict) else {}
    try:
        end = float(layer.get("end", 0) or 0)
    except (TypeError, ValueError):
        end = 0.0
    try:
        dur = float(duration_video or 0)
    except (TypeError, ValueError):
        dur = 0.0
    follow = bool(data.get("timelineIsVideo") or layer.get("timelineIsVideo"))
    if follow and dur > 0:
        return dur
    if dur > 0 and end > dur:
        return dur
    return end
def _clip_timed_layers(layers, t0, dur):
    """Giữ layer chồng lên [t0, t0+dur] và dời về mốc 0 (Fast Preview)."""
    out = []
    t1 = t0 + dur
    for layer in layers or []:
        try:
            start = float(layer.get("start", 0) or 0)
            end = float(layer.get("end", 0) or 0)
        except (TypeError, ValueError):
            continue
        if end <= t0 or start >= t1:
            continue
        item = copy.deepcopy(layer)
        item["start"] = max(0.0, start - t0)
        item["end"] = max(item["start"] + 0.05, min(dur, end - t0))
        out.append(item)
    return out

def render_video(__windown, option: str, width: int, height: int,
                  duration: str, input_path: str, output_path: str,
                  files: list,
                  images: list,
                  hooks: list,
                  subs: list,
                  contents: list,
                  AddOverlay: True,
                  AddAudio: True,
                  RenderRenderAutoTrim: True,
                  AddFillter: True,
                  RenameVideo: True,
                  audioConfig: dict,
                  scale: dict,
                  content_picker: "ContentPicker" = None,
                  blurs: list = None,
                  texts: list = None,
                  preview_start=None,
                  preview_duration=None,
                  output_suffix="",
                  crop_fill=False,
                  use_two_screen=False):
    ff_work = None
    orig_out_video = None
    orig_input_str = str(Path(input_path))
    input_file = None
    try:
        output_dir = Path(output_path)
        output_dir.mkdir(parents=True, exist_ok=True)
        scale = scale or {}
        audioConfig = audioConfig or {}
        files = files or []
        durationVideo = time_to_seconds(duration)
        input_file = Path(input_path)
        out_video = None
        chosen_text = None
        target_fps = 30
 
        if content_picker is not None:
            chosen_text = content_picker.pick()
        elif contents:
            chosen_text = random.choice(contents)
 
        name_suffix = "" if preview_start is not None else str(output_suffix or "")
        if RenameVideo and chosen_text:
            text_rename = "_".join(chosen_text.split()) + name_suffix
            out_video = output_dir / f"{text_rename}.mp4"
        else:
            file_name = "_".join(input_file.stem.split()) + name_suffix
            out_video = output_dir / f"{file_name}.mp4"
        profile = get_render_option(option)
        scale_x = scale.get("scaleX", 1)
        scale_y = scale.get("scaleY", 1)
 
        muteAudio = audioConfig.get("muteOriginalAudio", False)
        should_mute = muteAudio and AddAudio
 
        # ===== Chọn trước audio thay thế (phần 1) để có thể lấy độ dài của nó =====
        # cần làm TRƯỚC KHI build cmd, vì -ss của input video phải nằm trước -i.
        addAudioFile = audioConfig.get("addAudioFile", False)
        already_used_audio_path = None
 
        if AddAudio and should_mute and addAudioFile and files:
            audio_files = [
                f for f in files
                if f.lower().endswith((".mp3", ".wav", ".m4a"))
            ]
            if audio_files:
                already_used_audio_path = random.choice(audio_files)
 
        # ===== RenderRenderAutoTrim: nếu bật, độ dài video = độ dài audio thay thế =====
        # Đồng thời random cắt bỏ phần ĐẦU CỦA VIDEO GỐC (0.5s -> 2s) bằng -ss trên input video,
        # KHÔNG cắt audio.
        video_start_offset = 0.0
        if RenderRenderAutoTrim and already_used_audio_path:
            audio_duration = get_media_duration_seconds(already_used_audio_path)
            if audio_duration > 0:
                durationVideo = audio_duration
 
                min_cut = audioConfig.get("autoTrimStartMin", 1.0)
                max_cut = audioConfig.get("autoTrimStartMax", 3.0)
                candidate_offset = (
                    random.uniform(min_cut, max_cut) if max_cut > min_cut else min_cut
                )
 
                # không cắt quá phần video còn lại, phải chừa đủ durationVideo để render
                video_duration = get_media_duration_seconds(input_file)
                if video_duration > 0:
                    max_allowed_offset = max(0.0, video_duration - durationVideo)
                    candidate_offset = min(candidate_offset, max_allowed_offset)
 
                video_start_offset = max(0.0, candidate_offset)
 
        if preview_start is not None:
            t0 = max(0.0, float(preview_start or 0))
            dur = max(0.5, float(preview_duration or 5.0))
            vid_dur = get_media_duration_seconds(input_file) or durationVideo
            if t0 >= vid_dur:
                t0 = max(0.0, vid_dur - dur)
            dur = min(dur, max(0.5, vid_dur - t0))
            video_start_offset = t0
            durationVideo = dur
            hooks = _clip_timed_layers(hooks, t0, dur)
            subs = _clip_timed_layers(subs, t0, dur)
            texts = _clip_timed_layers(texts, t0, dur)
            blurs = _clip_timed_layers(blurs, t0, dur)
            images = _clip_timed_layers(images, t0, dur)
            file_name = "_".join(input_file.stem.split())
            out_video = output_dir / f"{file_name}_preview.mp4"

        try:
            if Path(out_video).resolve() == Path(input_path).resolve():
                out_video = output_dir / f"{Path(out_video).stem}_render.mp4"
        except Exception:
            pass

        orig_out_video = Path(out_video)
        input_file, out_video, ff_work = _prepare_ffmpeg_unicode_io(Path(input_path), orig_out_video)

        cmd = [str(FFMPEG_EXE), "-y"]
        if video_start_offset > 0:
            # -ss trước -i: seek nhanh, cắt bỏ phần đầu của video gốc
            cmd.extend(["-ss", str(round(video_start_offset, 3))])
        cmd.extend([
            "-thread_queue_size", "2048",
            "-i", str(input_file),
        ])
        has_audio = has_audio_stream(input_file)
 
        # Thêm overlay ảnh/video
        for img in images:
            overlay_path = (img.get("data") or {}).get("path", "")
            ext = Path(overlay_path).suffix.lower()
            if ext in (".mp4", ".mov", ".avi", ".mkv", ".webm"):
                cmd.extend([
                    "-thread_queue_size", "2048",
                    "-stream_loop", "-1",
                    "-t", str(durationVideo + 1),
                    "-i", overlay_path,
                ])
            else:
                cmd.extend([
                    "-thread_queue_size", "2048",
                    "-loop", "1",
                    "-framerate", str(target_fps),
                    "-t", str(durationVideo + 1),
                    "-i", overlay_path,
                ])
 
        # ===== PHẦN 1: thêm input audio thay thế vào lệnh ffmpeg (không cắt đầu audio) =====
        audio_file_index = None
        if already_used_audio_path:
            audio_file_index = 1 + len(images)
 
            cmd.extend([
                "-thread_queue_size", "2048",
                "-stream_loop", "-1",
                "-t", str(durationVideo),
                "-i", already_used_audio_path
            ])
 
        # ===== PHẦN 2: nhạc nền (bg audio), luôn cộng thêm nếu bật, độc lập với phần 1 =====
        bg_audio_index = None
        add_bg_audio = AddAudio and bool(audioConfig.get("addBgAudio", False))
        bg_list = audioConfig.get("listBgAudo", []) or []
 
        if add_bg_audio:
            bg_audio_path = None
 
            if bg_list:
                chosen_bg = random.choice(bg_list)
                bg_audio_path = chosen_bg["path"]
            elif files:
                audio_files = [
                    f for f in files
                    if f.lower().endswith((".mp3", ".wav", ".m4a"))
                    and f != already_used_audio_path
                ]
                if audio_files:
                    bg_audio_path = random.choice(audio_files)
 
            if bg_audio_path:
                bg_audio_index = 1 + len(images) + (1 if audio_file_index is not None else 0)
 
                cmd.extend([
                    "-thread_queue_size", "2048",
                    "-stream_loop", "-1",
                    "-t", str(durationVideo + 1),
                    "-i", bg_audio_path
                ])
 
        # ===== Video Overlay hiệu ứng (screen/light-leak) =====
        overlay_video_index = None
        if AddFillter:
            folder = DEFAULT_OVERLAY_FOLDER
            if not os.path.isdir(folder):
                raise Exception(f"Không tìm thấy thư mục video overlay: {folder}")
 
            overlay_files = glob.glob(os.path.join(folder, "*.mp4"))
            if not overlay_files:
                raise Exception(f"Không có video overlay trong: {folder}")
 
            overlay_video = random.choice(overlay_files)
            overlay_video_index = (
                1
                + len(images)
                + (1 if audio_file_index is not None else 0)
                + (1 if bg_audio_index is not None else 0)
            )
 
            cmd.extend([
                "-thread_queue_size", "2048",
                "-stream_loop", "-1",
                "-t", str(durationVideo + 1),
                "-i", overlay_video
            ])
 
        # ===== Build filter graph (cần input_index của overlay video) =====
        filter_complex, last_stream = CreateFilterComplex(
            input_file=input_file,
            files=files,
            video_width=width,
            video_height=height,
            images=images,
            hooks=hooks,
            texts=texts or [],
            subs=subs,
            scale_x=scale_x,
            scale_y=scale_y,
            durationVideo=durationVideo,
            contents_list=contents,
            AddOverlay=AddOverlay,
            AddAudio=AddAudio,
            AddFillter=AddFillter,
            chosen_textName=chosen_text,
            overlay_video_index=overlay_video_index,
            target_fps=target_fps,
            blurs=blurs or [],
            crop_fill=bool(crop_fill),
            use_two_screen=bool(use_two_screen),
        )
 
        full_filter_complex = filter_complex
 
        if not AddAudio:
            audio_out_label = None
        else:
            audio_filters, audio_out_label = build_audio_filters(
                has_audio=has_audio,
                should_mute=should_mute,
                audio_config=audioConfig,
                audio_file_index=audio_file_index,
                bg_audio_index=bg_audio_index,
                duration_video=durationVideo,
            )
            if audio_filters:
                full_filter_complex = filter_complex + ";" + ";".join(audio_filters)
 
        cmd.extend([
            "-filter_complex", full_filter_complex,
            "-map", f"[{last_stream}]",
        ])
 
        if audio_out_label:
            cmd.extend([
                "-map", f"[{audio_out_label}]",
                "-c:a", "aac",
                "-b:a", "192k",
            ])
        elif not AddAudio and has_audio:
            cmd.extend([
                "-map", "0:a?",
                "-c:a", "aac",
                "-b:a", "192k",
            ])
        else:
            cmd.extend(["-an"])
 
        cmd.extend([
            "-c:v", profile["encoder"],
            "-preset", profile["preset"],
            "-cq", profile["cq"],
            "-pix_fmt", "yuv420p",
            "-t", str(durationVideo),
            "-shortest",
            str(out_video)
        ])
        _safe_print(" ".join(cmd))
 
        def on_progress(percent):
            __windown.evaluate_js(
                f'updateMediaStatusProcess({json.dumps(orig_input_str)}, "{percent}", "processing")'
            )
 
        _runProgress(cmd, track_key=input_path, duration_seconds=durationVideo, on_progress=on_progress, out_video=str(out_video))
        _finalize_ffmpeg_unicode_io(out_video, orig_out_video, ff_work)
        ff_work = None

        return {
            "success": True,
            "output": str(orig_out_video),
            "message": "Tạo video thành công."
        }
 
    except FFmpegError as e:
        if ff_work:
            shutil.rmtree(ff_work, ignore_errors=True)
        return {
            "success": False,
            "message": "Render bị lỗi. Vui lòng kiểm tra lại. Có thể video đang xử lý cùng với thư mục render",
            "stopped": _stop_all_flag,
        }
 
    except Exception as e:
        if ff_work:
            shutil.rmtree(ff_work, ignore_errors=True)
        return {
            "success": False,
            "message": str(e)
        }
    finally:
        _cleanup_render_temps(orig_input_str, input_file)
#END FIX

def CreateFilterComplex(
    input_file:str, 
    files:list,   
    video_width: int,
    video_height: int,
    images: list,
    hooks: list,
    subs: list,
    scale_x: float = 1.0,
    scale_y: float = 1.0,
    durationVideo:float=1,
    contents_list:list=[],
    AddOverlay:bool=True,
    AddAudio:bool=True,
    AddFillter:bool=True,
    chosen_textName:str =None,
    content_picker: "ContentPicker" = None,
    overlay_video_index=None,      # <-- THÊM
    target_fps: int = 30,          # <-- THÊM
    overlay_blend_mode: str = "screen",   # <-- THÊM: screen/lighten/addition/overlay...
    overlay_opacity: float = 0.5,          # <-- THÊM: 0.0-1.0, độ mạnh hiệu ứng
    blurs: list = None,
    texts: list = None,
    crop_fill: bool = False,
    use_two_screen: bool = False,
):
    filters = []

    # ===================== 1. Base video =====================
    if use_two_screen:
        # Cùng kiểu Download Studio: nền phóng to + mờ, video gốc nằm giữa.
        filters.append("[0:v]split=2[tsfg][tsbg]")
        filters.append(
            f"[tsbg]scale={video_width}:{video_height}:force_original_aspect_ratio=increase,"
            f"scale=trunc(iw*5/4/2)*2:trunc(ih*5/4/2)*2,"
            f"crop={video_width}:{video_height},gblur=sigma=28,"
            f"fps={target_fps},setpts=PTS-STARTPTS,format=yuv420p[tsbgb]"
        )
        filters.append(
            f"[tsfg]scale={video_width}:{video_height}:force_original_aspect_ratio=decrease,"
            f"scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,"
            f"fps={target_fps},setpts=PTS-STARTPTS,format=yuv420p[tsfgb]"
        )
        filters.append("[tsbgb][tsfgb]overlay=(W-w)/2:(H-h)/2,setsar=1[bg]")
    elif crop_fill:
        filters.append(
            f"[0:v]scale={video_width}:{video_height}:"
            f"force_original_aspect_ratio=increase,"
            f"crop={video_width}:{video_height},"
            f"fps={target_fps},setpts=PTS-STARTPTS[bg]"
        )
    else:
        filters.append(
            f"[0:v]scale={video_width}:{video_height}:"
            f"force_original_aspect_ratio=decrease,"
            f"pad={video_width}:{video_height}:(ow-iw)/2:(oh-ih)/2,"
            f"fps={target_fps},setpts=PTS-STARTPTS[bg]"
        )

    current_stream = "bg"
    text_preloaded = []
    hook_from_txt = None
    if AddOverlay and texts:
        for layer in texts:
            lines, hook = _load_text_layer_bundle((layer or {}).get("data") or {}, files or [])
            text_preloaded.append(lines)
            if hook and not hook_from_txt:
                hook_from_txt = hook

    # ===================== 1.5. Region blur (timeline Blur layers) =====================
    if blurs:
        for i, blur in enumerate(blurs):
            data = blur.get("data") or {}
            start = float(blur.get("start", 0) or 0)
            end = float(blur.get("end", 0) or 0)
            if data.get("timelineIsVideo"):
                end = durationVideo

            x = _even_dim(blur.get("x", 0) or 0)
            y = _even_dim(blur.get("y", 0) or 0)
            w = _even_dim(blur.get("width", 0) or 0)
            h = _even_dim(blur.get("height", 0) or 0)
            if x + w > video_width:
                w = _even_dim(video_width - x)
            if y + h > video_height:
                h = _even_dim(video_height - y)
            if w < 2 or h < 2:
                continue

            opacity = data.get("opacity", 0.5)
            try:
                opacity = float(opacity)
            except (TypeError, ValueError):
                opacity = 0.5
            opacity = max(0.05, min(1.0, opacity))
            sigma = max(2.0, round(2.0 + opacity * 28.0, 2))

            enable = ""
            if end > start:
                enable = f":enable='between(t,{start},{end})'"

            filters.append(f"[{current_stream}]split[bbase{i}][breg{i}]")
            filters.append(
                f"[breg{i}]crop={w}:{h}:{x}:{y},gblur=sigma={sigma},format=yuv420p[bbl{i}]"
            )
            filters.append(
                f"[bbase{i}][bbl{i}]overlay={x}:{y}{enable}[bov{i}]"
            )
            current_stream = f"bov{i}"

    # ===================== 2. Images =====================
    if AddOverlay and images:
        for i, img in enumerate(images):
            img_width = round(img.get("width", video_width) or video_width)
            img_height = round(img.get("height", 200) or 200)
            img_x = round(img.get("x", 0))
            img_y = round(img.get("y", 0))
            opacity = img["data"]["opacity"]
            opacity = max(0.0, min(1.0, opacity))
            overlay_path = (img.get("data") or {}).get("path", "")
            is_video_ov = Path(overlay_path).suffix.lower() in (".mp4", ".mov", ".avi", ".mkv", ".webm")
            start = float(img.get("start", 0) or 0)
            end = _resolve_timed_end(img, durationVideo)
            pts = f"setpts=PTS-STARTPTS+{start}/TB" if is_video_ov else "setpts=PTS-STARTPTS"
            filters.append(
                f"[{i+1}:v]scale={img_width}:{img_height},"
                f"fps={target_fps},{pts}[img{i}]"
            )
            filters.append(f"[img{i}]format=rgba,colorchannelmixer=aa={opacity}[img{i}o]")

            if start == 0 and end == 0:
                filters.append(f"[{current_stream}][img{i}o]overlay={img_x}:{img_y}[ov{i}]")
            else:
                filters.append(
                    f"[{current_stream}][img{i}o]"
                    f"overlay={img_x}:{img_y}:"
                    f"enable='between(t,{start},{end})'"
                    f"[ov{i}]"
                )
            filters.append(f"[ov{i}]setpts=PTS-STARTPTS[ov{i}_r]")
            current_stream = f"ov{i}_r"

    # ===================== 2.5. Video Overlay hiệu ứng (screen/light-leak) =====================
    if AddFillter and overlay_video_index is not None:
        filters.append(
            f"[{overlay_video_index}:v]"
            f"scale={video_width}:{video_height}:force_original_aspect_ratio=increase,"
            f"crop={video_width}:{video_height},"
            f"fps={target_fps},setpts=PTS-STARTPTS,"
            f"format=gbrp[fx]"
        )
        filters.append(f"[{current_stream}]format=gbrp[base_fx_in]")
        filters.append(
            f"[base_fx_in][fx]"
            f"blend=all_mode='{overlay_blend_mode}':all_opacity={overlay_opacity}:shortest=1"
            f"[fx_out]"
        )
        filters.append(f"[fx_out]format=yuv420p[fx_out_y]")
        current_stream = "fx_out_y"

#     # ===================== 3. Hooks =====================
    if AddOverlay and hooks:
        for i, hook in enumerate(hooks):
            data = hook["data"]
            start = hook.get("start", 0)
            end = hook.get("end", 0)
            is_time_is_video = data.get("timelineIsVideo", False)
            if is_time_is_video:
                end = durationVideo
            x, y, w, h = hook["x"], hook["y"], hook["width"], hook["height"]

            is_two_line = data.get("isTowLine", False)
            is_hook_upper = data.get("isHookUpper", False)
            use_content_list = data.get("useContentList", False)
            chosen_text = None
            if hook_from_txt:
                chosen_text = hook_from_txt
            elif use_content_list and contents_list:
                if chosen_textName:
                    chosen_text = chosen_textName
                else:
                    chosen_text = random.choice(contents_list)
            else:
                chosen_text = data.get("text", "")

            if is_two_line:
                if hook_from_txt or (use_content_list and contents_list):
                    line1_raw, line2_raw = split_hook_text(chosen_text, data.get("countword_hook", 5))
                else:
                    line1_raw = data.get("line1", chosen_text)
                    line2_raw = data.get("line2", "")
            else:
                line1_raw = chosen_text
                line2_raw = ""

            if is_hook_upper:
                line1_raw = line1_raw.upper()
                line2_raw = line2_raw.upper()

            enable = ""
            if end > start:
                enable = f":enable='between(t,{start},{end})'"

            border_width = max(0, int(data.get("BorderWidth", 2) or 0))
            border_color_raw = data.get("BorderColor", "#000000")
            border_color = "0x" + str(border_color_raw).lstrip("#")
            hook_style = str(data.get("hookStyle") or "default").strip().lower()
            border_str = f":borderw={border_width}:bordercolor={border_color}" if border_width > 0 else ""
            box_color = f"{border_color}@0.72"

            if is_two_line:
                line_spacing_percent = data.get("lineSpacing", 10)
                if line_spacing_percent is None:
                    line_spacing_percent = 10

                text1 = escape_text_for_ffmpeg(line1_raw)
                font_file1 = _layer_font_file(data, "FontFile", "FontName")
                font_size1 = _css_fontsize_to_ffmpeg(_font_px(data.get("FontSize"), 18), scale_y, "drawtext")
                font_color1 = "0x" + data.get("FontColor", "#FFFFFF").lstrip("#")

                text2 = escape_text_for_ffmpeg(line2_raw)
                font_file2 = _layer_font_file(data, "FontFile2", "FontName2") or font_file1
                font_size2 = _css_fontsize_to_ffmpeg(
                    _font_px(data.get("FontSize2", data.get("FontSize")), 18), scale_y, "drawtext"
                )
                font_color2 = "0x" + data.get("FontColor2", data.get("FontColor", "#FFFFFF")).lstrip("#")

                gap_px = (line_spacing_percent / 100) * h

                pos_x1 = f"{x}+({w}-text_w)/2"
                pos_y1 = f"{y}"
                current_stream = _append_hook_drawtext(
                    filters, current_stream, f"hook{i}_l1", text1, font_file1, font_size1, font_color1,
                    border_str, pos_x1, pos_y1, enable, hook_style, start, end, box_color,
                )

                pos_x2 = f"{x}+({w}-text_w)/2"
                pos_y2 = f"{y}+{font_size1}+{gap_px}"
                current_stream = _append_hook_drawtext(
                    filters, current_stream, f"hook{i}_l2", text2, font_file2, font_size2, font_color2,
                    border_str, pos_x2, pos_y2, enable, hook_style, start, end, box_color,
                )

            else:
                text = escape_text_for_ffmpeg(line1_raw)
                font_file = _layer_font_file(data)
                font_size = _css_fontsize_to_ffmpeg(_font_px(data.get("FontSize"), 18), scale_y, "drawtext")
                font_color = "0x" + data.get("FontColor", "#FFFFFF").lstrip("#")
                pos_x = f"{x}+({w}-text_w)/2"
                pos_y = f"{y}+({h}-text_h)/2"
                current_stream = _append_hook_drawtext(
                    filters, current_stream, f"hook{i}", text, font_file, font_size, font_color,
                    border_str, pos_x, pos_y, enable, hook_style, start, end, box_color,
                )


    # ===================== 3.5. Text card (list from .txt / typed lines) =====================
    if AddOverlay and texts:
        current_stream = _append_text_layers(
            filters,
            current_stream,
            texts,
            extra_files=files or [],
            duration_video=durationVideo,
            video_width=video_width,
            video_height=video_height,
            scale_y=scale_y,
            scale_x=scale_x,
            input_file=input_file,
            preloaded_lines=text_preloaded,
        )

    file_ass = str(Path(input_file).with_suffix(".ass"))
    base_font_size = 18
    base_outline = 3
    base_margin_v = 40
    base_margin_lr = 20

    preset = srt_to_ass.AssStylePreset(
        FontName="Roboto",
        FontSize=base_font_size,
        Outline=max(1, round(base_outline)),
        MarginV=round(base_margin_v * scale_y),
        MarginL=round(base_margin_lr * scale_y),
        MarginR=round(base_margin_lr * scale_y),
        PrimaryColor="&H00FFFFFF",
        Alignment=2,
        PopScaleFrom=160,      # giữ nguyên, đây là % nên không cần scale
        PopDurationMs=150,     # thời gian (ms), cũng không cần scale theo resolution
    )
    words_per_chunk=2
    sub_x = None
    sub_y = None
    sub_width = None
    sub_height = None
    style_mode="pop"
    style_karaoke = True
    extra_files = files or []
    if AddOverlay and subs:
        first_sub = subs[0]
        data0 = dict(first_sub.get("data") or {})

        words_per_chunk = data0.get("wordCountInLine", 2)
        sub_x = data0.get("x")
        sub_y = data0.get("y")
        sub_width = data0.get("width")
        sub_height = data0.get("height")
        preset.Uppercase = data0.get("Uppercase", False)
        font_file = _layer_font_file(data0)
        try:
            preset.FontSize = _css_fontsize_to_ffmpeg(
                _font_px(data0.get("FontSize"), 14), 1, "ass", font_file
            )
        except (TypeError, ValueError):
            preset.FontSize = _css_fontsize_to_ffmpeg(14, 1, "ass", font_file)
        try:
            preset.Outline = max(0, int(data0.get("BorderWidth", 3) or 0))
        except (TypeError, ValueError):
            preset.Outline = 3
        if data0.get("PrimaryColor"):
            preset.PrimaryColor = _safe_ass_color(data0["PrimaryColor"])
        if data0.get("HighlightColor"):
            preset.HighlightColor = _safe_ass_color(data0["HighlightColor"], "&H0000FFFF")
        if data0.get("BorderColor"):
            preset.OutlineColor = _safe_ass_color(data0["BorderColor"], "&H00000000")
        font_name = str(data0.get("FontName") or "Roboto").strip() or "Roboto"
        preset.FontName = _font_ass_family(font_file, font_name)
        try:
            fw = int(data0.get("FontWeight") or 400)
        except (TypeError, ValueError):
            fw = 400
        style_name = str(data0.get("FontStyle") or "").strip().lower()
        preset.Bold = fw >= 700 or style_name in ("bold", "semibold")
        fonts_dir = ""
        if font_file and Path(font_file).is_file():
            fonts_dir = str(Path(font_file).resolve().parent)
        elif _bundled_font_dirs():
            fonts_dir = str(_bundled_font_dirs()[0])

        style_mode = _resolve_sub_style_mode(data0)

        use_file_srt = bool(data0.get("userFileSrt", True))
        file_srts = [f for f in extra_files if str(f).lower().endswith(".srt")]
        input_srt = None
        if use_file_srt and file_srts:
            input_srt = random.choice(file_srts)
        else:
            temp_srt = str(Path(input_file).with_name(Path(input_file).stem + "_layer_sub.srt"))
            # Checkbox tắt: chỉ lấy layer nhập text. Không có file SRT: vẫn lấy text kể cả khi checkbox còn bật.
            if _write_subs_text_srt(
                subs, durationVideo, temp_srt, skip_file_layers=(not use_file_srt)
            ):
                input_srt = temp_srt

        if input_srt:
            clip_rect = None
            if style_mode == "box":
                bx, by, bw, bh = _sub_layer_px_rect(first_sub, video_width, video_height)
                if bw >= 2 and bh >= 2:
                    border_hex = str(data0.get("BorderColor") or "#000000").lstrip("#")
                    if len(border_hex) != 6:
                        border_hex = "000000"
                    try:
                        box_op = float(data0.get("BoxOpacity", 0.78))
                    except (TypeError, ValueError):
                        box_op = 0.78
                    box_op = max(0.0, min(1.0, box_op))
                    try:
                        radius_ui = float(data0.get("BoxRadius", 16) or 0)
                    except (TypeError, ValueError):
                        radius_ui = 16
                    radius_px = int(round(radius_ui * min(float(scale_x or 1), float(scale_y or 1))))
                    png_path = Path(input_file).with_name(Path(input_file).stem + "_layer_sub_box.png")
                    _write_rounded_box_png(png_path, bw, bh, radius_px, border_hex, box_op)
                    movie_src = prepare_font_path_for_ffmpeg(str(png_path))
                    ranges = _sub_box_time_ranges(subs, durationVideo, input_srt)
                    stream = current_stream
                    chunks = _chunk_time_ranges(ranges, 40)
                    if not chunks:
                        chunks = [[]]
                    for ci, chunk in enumerate(chunks):
                        lab = f"subbg{ci}"
                        out_box = f"subbox{ci}"
                        en = _ffmpeg_enable_betweens_overlay(chunk)
                        filters.append(
                            f"movie=filename={movie_src},format=rgba,setpts=PTS-STARTPTS[{lab}]"
                        )
                        filters.append(
                            f"[{stream}][{lab}]overlay=x={bx}:y={by}:format=auto{en}[{out_box}]"
                        )
                        stream = out_box
                    current_stream = stream
                    clip_rect = (bx, by, bx + bw, by + bh)
                    max_fs = max(10, int(bh * 0.48))
                    if int(preset.FontSize or 0) > max_fs:
                        preset.FontSize = max_fs
                    preset.Alignment = 5

            srt_to_ass.srt_to_ass(
                input_srt, file_ass, preset,
                play_res_x=video_width,
                play_res_y=video_height,
                words_per_chunk=words_per_chunk,
                sub_x=sub_x, sub_y=sub_y,
                sub_width=sub_width, sub_height=sub_height,
                style_mode=style_mode,
                clip_rect=clip_rect,
            )
            out_sub = "subbed"
            sub_path_escaped = prepare_font_path_for_ffmpeg(file_ass)
            fontsdir_opt = ""
            if fonts_dir:
                fontsdir_opt = ":fontsdir=" + prepare_font_path_for_ffmpeg(fonts_dir)
            filters.append(
                f"[{current_stream}]ass={sub_path_escaped}{fontsdir_opt}[{out_sub}]"
            )
            current_stream = out_sub
    return ";".join(filters), current_stream


SUB_STYLE_MODES = ("default", "karaoke", "pop", "one_word", "box", "bounce", "fade")


def _resolve_sub_style_mode(data) -> str:
    data = data or {}
    mode = str(data.get("styleMode") or data.get("style_mode") or "").strip().lower()
    if mode in SUB_STYLE_MODES:
        return mode
    return "karaoke" if data.get("style_karaoke", True) else "default"


def _parse_srt_time_ranges(srt_path):
    ranges = []
    try:
        text = Path(srt_path).read_text(encoding="utf-8-sig")
    except Exception:
        try:
            text = Path(srt_path).read_text(encoding="utf-8", errors="replace")
        except Exception:
            return ranges
    for match in re.finditer(
        r"(\d\d:\d\d:\d\d,\d\d\d)\s*-->\s*(\d\d:\d\d:\d\d,\d\d\d)",
        text,
    ):
        start = srt_to_ass._parse_srt_time(match.group(1))
        end = srt_to_ass._parse_srt_time(match.group(2))
        if end > start:
            ranges.append((start, end))
    return ranges


def _sub_box_time_ranges(subs, duration_video, input_srt=None):
    ranges = []
    for sub in subs or []:
        data = sub.get("data") or {}
        if data.get("userFileSrt"):
            continue
        start = float(sub.get("start", 0) or 0)
        end = float(sub.get("end", duration_video) or duration_video)
        if data.get("timelineIsVideo"):
            end = float(duration_video)
        if end > start:
            ranges.append((start, end))
    if not ranges and input_srt:
        ranges = _parse_srt_time_ranges(input_srt)
    if not ranges and subs:
        sub = subs[0]
        data = sub.get("data") or {}
        start = float(sub.get("start", 0) or 0)
        end = float(sub.get("end", duration_video) or duration_video)
        if data.get("timelineIsVideo"):
            end = float(duration_video)
        if end > start:
            ranges.append((start, end))
    return ranges


def _chunk_time_ranges(ranges, size=40):
    ranges = list(ranges or [])
    if not ranges:
        return [[]]
    return [ranges[i : i + size] for i in range(0, len(ranges), size)]


def _ffmpeg_enable_betweens(ranges):
    if not ranges:
        return ""
    parts = [f"between(t\\,{a:.3f}\\,{b:.3f})" for a, b in ranges]
    return ":enable='" + "+".join(parts) + "'"


def _ffmpeg_enable_betweens_overlay(ranges):
    if not ranges:
        return ""
    parts = [f"between(t,{a:.3f},{b:.3f})" for a, b in ranges]
    return ":enable='" + "+".join(parts) + "'"


def _sub_layer_px_rect(sub, video_width: int, video_height: int):
    """Khung sub trên timeline: ưu tiên pixel (scalePositional), fallback tỉ lệ 0-1."""
    data = (sub or {}).get("data") or {}
    vw, vh = int(video_width), int(video_height)

    def _edge(px_key, ratio_key, full):
        if sub.get(px_key) is not None:
            try:
                return int(round(float(sub[px_key])))
            except (TypeError, ValueError):
                pass
        try:
            return int(round(float(data.get(ratio_key) or 0) * full))
        except (TypeError, ValueError):
            return 0

    x = max(0, _edge("x", "x", vw))
    y = max(0, _edge("y", "y", vh))
    w = max(2, _edge("width", "width", vw))
    h = max(2, _edge("height", "height", vh))
    if x + w > vw:
        w = max(2, vw - x)
    if y + h > vh:
        h = max(2, vh - y)
    return x, y, w, h


def _merge_srt_bodies(bodies) -> str:
    n = 1
    out = []
    for body in bodies:
        blocks = re.split(r"\n\s*\n", (body or "").strip())
        for block in blocks:
            lines = [l for l in block.splitlines() if l.strip()]
            if not lines:
                continue
            if lines[0].strip().isdigit():
                lines[0] = str(n)
            else:
                lines.insert(0, str(n))
            n += 1
            out.append("\n".join(lines))
    return ("\n\n".join(out) + "\n") if out else ""


def _write_subs_text_srt(subs, duration_video: float, dest_path: str, skip_file_layers: bool = True) -> bool:
    """Build a timed .srt from timeline sub layers that have typed text."""
    chunks = []
    for sub in subs or []:
        data = sub.get("data") or {}
        if skip_file_layers and data.get("userFileSrt"):
            continue
        text = (data.get("text") or "").strip()
        if not text:
            continue
        start = float(sub.get("start", 0) or 0)
        end = float(sub.get("end", duration_video) or duration_video)
        if data.get("timelineIsVideo"):
            end = float(duration_video)
        if end <= start:
            end = min(float(duration_video or 0) or (start + 2.0), start + 2.0)
        cues = subtitle_utils.parse_txt(text)
        if not cues:
            continue
        chunks.append(
            subtitle_utils.build_srt(
                cues,
                max(0.2, end - start),
                offset_seconds=start,
            )
        )
    merged = _merge_srt_bodies(chunks)
    if not merged.strip():
        return False
    Path(dest_path).write_text(merged, encoding="utf-8")
    return True
def to_ass_color(hex_color: str, alpha: str = "00") -> str:
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        raise ValueError(f"Màu không hợp lệ: {hex_color}")
    r, g, b = hex_color[0:2], hex_color[2:4], hex_color[4:6]
    return f"&H{alpha}{b}{g}{r}".upper()


def _safe_ass_color(hex_color: str, default: str = "&H00FFFFFF") -> str:
    try:
        return to_ass_color(hex_color or "#FFFFFF")
    except Exception:
        return default


def _ass_timestamp(t) -> str:
    t = max(0.0, float(t or 0))
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t - h * 3600 - m * 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _escape_ass_text(s: str) -> str:
    return (s or "").replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}")


def _split_text_colon(line: str):
    s = (line or "").strip()
    for i, ch in enumerate(s):
        if ch in ":：":
            return s[: i + 1].rstrip(), s[i + 1 :].strip()
    return s, ""


def _measure_font(font_file, font_size):
    size = max(8, int(round(float(font_size or 22))))
    path = _resolve_font_file(font_file)
    if path:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            pass
    return None


def _text_width_px(text, font, font_size) -> float:
    s = str(text or "")
    if not s:
        return 0.0
    if font is not None:
        try:
            if hasattr(font, "getlength"):
                return float(font.getlength(s))
            bbox = font.getbbox(s)
            return float(bbox[2] - bbox[0])
        except Exception:
            pass
    return len(s) * max(6.0, float(font_size or 22) * 0.42)


def _colored_parts_width(parts, font, font_size, gap_px) -> float:
    left = " ".join(t for t, side in parts if side == "1")
    right = " ".join(t for t, side in parts if side == "2")
    w = _text_width_px(left, font, font_size) + _text_width_px(right, font, font_size)
    if left and right:
        w += gap_px
    return w


def _split_token_to_width(token, max_w, font, font_size):
    t = str(token or "")
    if not t:
        return []
    if _text_width_px(t, font, font_size) <= max_w:
        return [t]
    out = []
    cur = ""
    for ch in t:
        trial = cur + ch
        if cur and _text_width_px(trial, font, font_size) > max_w:
            out.append(cur)
            cur = ch
        else:
            cur = trial
    if cur:
        out.append(cur)
    return out


def _wrap_colored_text_line(line: str, font_size, box_w_px, font_file="") -> list:
    left, right = _split_text_colon(line)
    items = []
    items.extend((w, "1") for w in str(left or "").split() if w)
    items.extend((w, "2") for w in str(right or "").split() if w)
    if not items:
        return [(line or "", "")]
    max_w = max(8.0, float(box_w_px or 0))
    gap_px = max(4.0, float(font_size or 22) * 0.28)
    font = _measure_font(font_file, font_size)
    rows = []
    cur = []

    def flush():
        nonlocal cur
        if not cur:
            return
        l = " ".join(t for t, s in cur if s == "1")
        r = " ".join(t for t, s in cur if s == "2")
        rows.append((l, r))
        cur = []

    for token, side in items:
        for chunk in _split_token_to_width(token, max_w, font, font_size):
            nxt = cur + [(chunk, side)]
            if cur and _colored_parts_width(nxt, font, font_size, gap_px) > max_w:
                flush()
            cur.append((chunk, side))
    flush()
    return rows or [(left or line or "", right or "")]


_HOOK_HEADER_RE = re.compile(r"^hook\s*[:：]\s*(.*)$", re.IGNORECASE)


def _split_hook_header(lines):
    lines = [str(ln).strip() for ln in (lines or []) if str(ln).strip()]
    if not lines:
        return [], None
    m = _HOOK_HEADER_RE.match(lines[0])
    if not m:
        return lines, None
    hook = (m.group(1) or "").strip()
    return lines[1:], hook or None


def _read_txt_file_lines(path):
    try:
        raw = Path(path).read_text(encoding="utf-8-sig")
    except Exception:
        try:
            raw = Path(path).read_text(encoding="utf-8", errors="replace")
        except Exception:
            return []
    return [ln.strip() for ln in raw.splitlines() if ln.strip()]


def _load_text_layer_bundle(data, extra_files):
    """Trả (dòng text card, hook từ dòng đầu 'hook:...'). Cùng một file txt."""
    data = data or {}
    if data.get("useFileText") and extra_files:
        txts = [f for f in extra_files if str(f).lower().endswith(".txt")]
        if txts:
            lines = _read_txt_file_lines(random.choice(txts))
            text_lines, hook = _split_hook_header(lines)
            if text_lines or hook:
                return text_lines, hook
    raw = data.get("text") or ""
    return [ln.strip() for ln in str(raw).splitlines() if ln.strip()], None


def _load_text_layer_lines(data, extra_files):
    lines, _hook = _load_text_layer_bundle(data, extra_files)
    return lines


def _write_rounded_box_png(path, w, h, radius, hex_color, opacity):
    w = max(2, int(w))
    h = max(2, int(h))
    r = max(0, min(int(radius), w // 2, h // 2))
    hx = str(hex_color or "1c1c1c").lstrip("#")
    if len(hx) != 6:
        hx = "1c1c1c"
    rgb = tuple(int(hx[i : i + 2], 16) for i in (0, 2, 4))
    a = int(round(max(0.0, min(1.0, float(opacity))) * 255))
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    box = (0, 0, w - 1, h - 1)
    fill = (*rgb, a)
    try:
        draw.rounded_rectangle(box, radius=r, fill=fill)
    except Exception:
        draw.rectangle(box, fill=fill)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    img.save(path)


def _append_text_layers(
    filters,
    current_stream,
    texts,
    extra_files,
    duration_video,
    video_width,
    video_height,
    scale_y,
    input_file,
    scale_x=1.0,
    preloaded_lines=None,
):
    for i, layer in enumerate(texts or []):
        data = (layer or {}).get("data") or {}
        start = float(layer.get("start", 0) or 0)
        end = float(layer.get("end", 0) or 0)
        if data.get("timelineIsVideo"):
            end = float(duration_video)
        x, y, w, h = _sub_layer_px_rect(layer, video_width, video_height)
        if preloaded_lines is not None and i < len(preloaded_lines):
            lines = preloaded_lines[i]
        else:
            lines = _load_text_layer_lines(data, extra_files)
        if not lines:
            continue
        try:
            pad_pct = float(data.get("BoxPadding", 9) or 0)
        except (TypeError, ValueError):
            pad_pct = 9
        pad_pct = max(0.0, min(25.0, pad_pct)) / 100.0
        try:
            user_fs = _font_px(data.get("FontSize"), 22, min_v=8)
        except (TypeError, ValueError):
            user_fs = 22
        font_file = _layer_font_file(data)
        fs = _css_fontsize_to_ffmpeg(user_fs, 1, "ass", font_file)
        debug_log_font_ass(
            "TEXT layer",
            FontName=data.get("FontName"),
            assFontName=_font_ass_family(font_file, data.get("FontName")),
            FontColor=data.get("FontColor"),
            FontColor2=data.get("FontColor2"),
            BorderColor=data.get("BorderColor"),
            BorderColor1=data.get("BorderColor1"),
            BorderWidth=data.get("BorderWidth"),
            BorderWidth1=data.get("BorderWidth1"),
            user_fs=user_fs,
            ass_fs=fs,
            box=f"x={x} y={y} w={w} h={h}",
            input_file=str(input_file),
        )
        try:
            gap_pct = float(data.get("BoxLineGap", 40) or 0)
        except (TypeError, ValueError):
            gap_pct = 40
        gap_pct = max(0.0, min(150.0, gap_pct)) / 100.0
        line_step = max(user_fs + 1, int(round(user_fs * 1.2 + user_fs * gap_pct)))
        pad_x = max(4, int(round(w * pad_pct)))
        pad_y = pad_x
        inner_w = max(8, int(w) - pad_x * 2)
        visual_rows = []
        for line in lines:
            visual_rows.extend(_wrap_colored_text_line(line, user_fs, inner_w, font_file))
        if not visual_rows:
            continue
        n = len(visual_rows)
        line_h = line_step
        need_h = pad_y * 2 + n * line_h
        if need_h > h:
            extra = need_h - h
            h = need_h
            y = max(0, int(y) - extra // 2)
            if y + h > int(video_height):
                y = max(0, int(video_height) - h)
        h = max(2, int(h))
        box_hex = str(data.get("BoxColor") or "#1c1c1c").lstrip("#")
        try:
            box_op = float(data.get("BoxOpacity", 0.78))
        except (TypeError, ValueError):
            box_op = 0.78
        box_op = max(0.0, min(1.0, box_op))
        try:
            radius_ui = float(data.get("BoxRadius", 24) or 0)
        except (TypeError, ValueError):
            radius_ui = 24
        radius_px = int(round(radius_ui * min(float(scale_x or 1), float(scale_y or 1))))
        enable = ""
        enable_ov = ""
        if end > start:
            enable = f":enable='between(t\\,{start:.3f}\\,{end:.3f})'"
            enable_ov = f":enable='between(t,{start:.3f},{end:.3f})'"
        png_path = Path(input_file).with_name(Path(input_file).stem + f"_layer_text_box_{i}.png")
        _write_rounded_box_png(png_path, w, h, radius_px, box_hex, box_op)
        movie_src = prepare_font_path_for_ffmpeg(str(png_path))
        bg_lab = f"txtbg{i}"
        out_box = f"txtbox{i}"
        filters.append(
            f"movie=filename={movie_src},format=rgba,setpts=PTS-STARTPTS[{bg_lab}]"
        )
        filters.append(
            f"[{current_stream}][{bg_lab}]overlay=x={x}:y={y}:format=auto{enable_ov}[{out_box}]"
        )
        current_stream = out_box

        c1 = _safe_ass_color(data.get("FontColor") or "#FFD400")
        c2 = _safe_ass_color(data.get("FontColor2") or "#FF1A1A")
        outline = _safe_ass_color(data.get("BorderColor") or "#FFFFFF")
        outline1 = _safe_ass_color(data.get("BorderColor1") or "#000000")
        try:
            bord = max(0, int(data.get("BorderWidth", 3) or 0))
        except (TypeError, ValueError):
            bord = 3
        try:
            bord1 = max(0, int(data.get("BorderWidth1", 2) or 0))
        except (TypeError, ValueError):
            bord1 = 2
        font_name = _font_ass_family(font_file, str(data.get("FontName") or "Roboto"))
        try:
            fw = int(data.get("FontWeight") or 400)
        except (TypeError, ValueError):
            fw = 400
        style_name = str(data.get("FontStyle") or "").strip().lower()
        bold = 1 if fw >= 700 or style_name in ("bold", "semibold") else 0
        fonts_dir = ""
        if font_file and Path(font_file).is_file():
            fonts_dir = str(Path(font_file).resolve().parent)
        elif _bundled_font_dirs():
            fonts_dir = str(_bundled_font_dirs()[0])
        upper = bool(data.get("isHookUpper"))
        events = []
        for li, (left, right) in enumerate(visual_rows):
            if upper:
                left, right = left.upper(), right.upper()
            py = int(round(y + pad_y + li * line_h))
            px = int(round(x + pad_x))
            body = (
                rf"{{\an7\pos({px},{py})\fn{font_name}\fs{_fmt_ass_fs(fs)}\b{bold}\shad1}}"
                rf"{{\c{c1}&\3c{outline1}&\bord{bord1}}}{_escape_ass_text(left)}"
            )
            if right:
                body += (
                    rf" {{\c{c2}&\3c{outline}&\bord{bord}}}{_escape_ass_text(right)}"
                )
            events.append(
                f"Dialogue: 0,{_ass_timestamp(start)},{_ass_timestamp(end)},"
                f"Default,,0,0,0,,{body}"
            )
        ass_path = Path(input_file).with_name(Path(input_file).stem + f"_layer_text_{i}.ass")
        header = (
            "[Script Info]\n"
            "ScriptType: v4.00+\n"
            f"PlayResX: {int(video_width)}\n"
            f"PlayResY: {int(video_height)}\n"
            "WrapStyle: 2\n"
            "ScaledBorderAndShadow: yes\n\n"
            "[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
            "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
            "Alignment, MarginL, MarginR, MarginV, Encoding\n"
            f"Style: Default,{font_name},{_fmt_ass_fs(fs)},{c1},{c1},{outline},"
            f"&H00000000,{bold},0,0,0,100,100,0,0,1,0,1,7,10,10,10,1\n\n"
            "[Events]\n"
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        )
        ass_path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
        out_txt = f"txtass{i}"
        ass_escaped = prepare_font_path_for_ffmpeg(str(ass_path))
        fontsdir_opt = ""
        if fonts_dir:
            fontsdir_opt = ":fontsdir=" + prepare_font_path_for_ffmpeg(fonts_dir)
        filters.append(f"[{current_stream}]ass={ass_escaped}{fontsdir_opt}[{out_txt}]")
        current_stream = out_txt
    return current_stream


def _concat_list_line(path) -> str:
    p = Path(path).resolve().as_posix().replace("'", r"'\''")
    return f"file '{p}'"


def _normalize_clip_for_merge(input_path, out_path, tw, th, fps, duration, has_audio, profile, track_key):
    """Đưa 1 clip về cùng size/fps/audio để concat demuxer (-c copy) không lệch stream."""
    vf = (
        f"scale={tw}:{th}:force_original_aspect_ratio=decrease,"
        f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuv420p"
    )
    encoder = profile["encoder"]
    cmd = [str(FFMPEG_EXE), "-y", "-i", str(input_path)]

    if has_audio:
        cmd.extend([
            "-vf", vf,
            "-af", "aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo",
            "-map", "0:v:0",
            "-map", "0:a:0",
        ])
    else:
        dur = duration if duration and duration > 0 else 1
        cmd.extend([
            "-f", "lavfi", "-t", str(dur),
            "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-vf", vf,
            "-map", "0:v:0",
            "-map", "1:a:0",
        ])

    cmd.extend(["-c:v", encoder, "-preset", profile["preset"]])
    if encoder == "h264_nvenc":
        cmd.extend(["-cq", str(profile.get("cq", 23))])
    else:
        cmd.extend(["-crf", str(profile.get("crf", 23))])
    cmd.extend([
        "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        str(out_path),
    ])
    _run(cmd, track_key=track_key)


def merge_video(__windown, option: str, input_paths: list, output_path, output_name: str,
                 width: int = None, height: int = None, target_fps: int = 30) -> dict:
    """
    Ghép N phân cảnh. Không dùng concat filter (mở hết input cùng lúc → dễ deadlock từ 4 clip trở lên).
    Cách làm: encode từng clip ra file tạm cùng spec, rồi ghép bằng concat demuxer.
    """
    out_video = None
    tmp_dir = None
    try:
        if not input_paths:
            return {"success": False, "message": "Danh sách video để ghép đang trống."}

        if _stop_all_flag:
            return {"success": False, "stopped": True, "message": "Đã dừng trước khi xử lý."}
        ok, err_msg = validate_input_paths(input_paths)
        if not ok:
            __windown.evaluate_js(
                f'updateMediaStatusMerge({json.dumps(output_name)}, {json.dumps(err_msg)}, "error", null);'
            )
            return {"success": False, "message": err_msg}
        output_dir = Path(output_path)
        output_dir.mkdir(parents=True, exist_ok=True)
        base_name = output_name.strip() if output_name else f"merge_{uuid.uuid4().hex[:8]}"
        out_video = output_dir / f"{base_name}.mp4"

        missing = [p for p in input_paths if not Path(p).exists()]
        if missing:
            return {"success": False, "message": "Không tìm thấy file: " + ", ".join(missing)}

        durations = []
        has_audio_list = []
        first_w, first_h = None, None
        for i, p in enumerate(input_paths):
            d, w, h = get_video_info(p)
            durations.append(d or 0)
            has_audio_list.append(has_audio_stream(p))
            if i == 0:
                first_w, first_h = w, h

        target_w = width or first_w or 1080
        target_h = height or first_h or 1920
        total_duration = sum(durations)
        profile = get_render_option(option)
        n = len(input_paths)

        def report(percent):
            __windown.evaluate_js(
                f'updateMediaStatusMerge({json.dumps(output_name)}, "Đang ghép video {percent}%", "processing")'
            )

        tmp_dir = Path(tempfile.mkdtemp(prefix="rs_merge_"))
        normalized = []
        for i, p in enumerate(input_paths):
            if _stop_all_flag:
                return {"success": False, "stopped": True, "message": "Đã dừng."}
            part = tmp_dir / f"part_{i:04d}.mp4"
            report(int((i / max(n, 1)) * 90))
            _normalize_clip_for_merge(
                p, part, target_w, target_h, target_fps,
                durations[i], has_audio_list[i], profile,
                track_key=f"{output_name}#p{i}",
            )
            normalized.append(part)

        list_file = tmp_dir / "concat.txt"
        with open(list_file, "w", encoding="utf-8") as f:
            for part in normalized:
                f.write(_concat_list_line(part) + "\n")

        concat_cmd = [
            str(FFMPEG_EXE), "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(list_file),
            "-c", "copy",
            "-movflags", "+faststart",
            str(out_video),
        ]
        _safe_print(" ".join(concat_cmd))

        def on_concat_progress(percent):
            report(min(100, 90 + int(percent * 0.1)))

        _runProgress(
            concat_cmd,
            track_key=output_name,
            duration_seconds=total_duration or 1,
            on_progress=on_concat_progress,
            out_video=str(out_video),
        )
        report(100)

        return {"success": True, "output": str(out_video), "message": "Ghép video thành công."}

    except FFmpegError as e:
        print(f"[merge_video FFmpegError] {output_name}: {str(e)[:800]}")
        return {"success": False, "message": f"Ghép video bị lỗi: {str(e)[:500]}", "stopped": _stop_all_flag}

    except Exception as e:
        print(f"[merge_video EXCEPTION] {output_name}")
        print(traceback.format_exc())
        if _stop_all_flag:
            return {"success": False, "stopped": True, "message": str(e)}
        return {"success": False, "message": str(e)}
    finally:
        if tmp_dir and Path(tmp_dir).exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)

def find_media_by_stem_name(folder: str, stem_name: str):
    """
    Tìm file trong `folder` có tên (không kèm đuôi) khớp với `stem_name`.
    VD: stem_name="4" -> tìm "4.mp4", "4.mov", "4.mkv"...

    Returns:
        str | None: đường dẫn đầy đủ nếu tìm thấy, None nếu không có.
    """
    folder_path = Path(folder)
    if not folder_path.is_dir():
        return None

    matches = list(folder_path.glob(f"{stem_name}.*"))

    # Ưu tiên các đuôi video phổ biến nếu có nhiều match (VD: vừa có 4.mp4 vừa có 4.srt)
    video_exts = {".mp4", ".mov", ".mkv", ".avi", ".webm"}
    video_matches = [m for m in matches if m.suffix.lower() in video_exts]

    if video_matches:
        return str(video_matches[0])
    if matches:
        return str(matches[0])
    return None


def find_transition_videos(folder: str, names: list) -> dict:
    """
    Tìm nhiều video transition cùng lúc theo danh sách tên.

    Args:
        folder: thư mục chứa các video transition
        names: danh sách tên cần tìm, VD: ["4", "3", "2", "1"]

    Returns:
        dict: { "4": "D:\\...\\4.mp4", "3": "D:\\...\\3.mp4", "2": None, ... }
              (None nếu không tìm thấy)
    """
    result = {}
    for name in names:
        result[name] = find_media_by_stem_name(folder, name)
    return result    