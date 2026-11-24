
import sys
import io


if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
from datetime import datetime
import os
import re
import base64
import mimetypes
import unicodedata
import threading
import traceback
import json
import platform
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from subprocess_utils import popen_hidden
import webview
import subprocess
import shutil
import audio_utils
import video_utils
import pipeline_wf as workflow
import scene_studio
import flowkit_bridge
import fb_queue
import data_queue
import sheet_queue
import vera_tts
import paraphrase_srt
import subtitle_utils
import account 
import media_server
from urllib.parse import quote, urlencode, urlparse, parse_qsl, urlunparse
from downloader import DownloadManager, normalize_socks5_proxy
import whisper_utils
import uuid
import requests
import time
# MEDIA_FOLDER = r"D:\Media"
# THUMB_FOLDER = r"D:\MediaThumb"

media_server.start()

def get_resource_dir() -> Path:
    """Nơi chứa web/ (html, js, css, fonts) — được PyInstaller bundle qua --add-data.
    Khi build: nằm trong _internal (hoặc thư mục tạm _MEIPASS nếu dùng --onefile).
    Khi dev: nằm cùng chỗ với main.py."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent

def get_app_dir() -> Path:
    """Nơi chứa exe thật — dùng cho output, tmp, config, ffmpeg (những thứ cần
    ghi file hoặc người dùng có thể tự thêm/sửa)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent

RESOURCE_DIR = get_resource_dir()   # dùng cho web/index.html, web/loading.html, fonts
APP_DIR = get_app_dir()             # dùng cho outputs/, _tmp/, config/, ffmpeg/

BASE_DIR = APP_DIR   # giữ tên BASE_DIR để các chỗ khác trong code không phải sửa nhiều

OUTPUT_DIR = APP_DIR / "outputs"
TMP_DIR = APP_DIR / "_tmp"
PARAPHRASE_DIR = OUTPUT_DIR / "paraphrased"
FONT_DIR = os.path.join(RESOURCE_DIR, "web", "fonts") 
TRANSITION_DIR = BASE_DIR / "transitions" 
ICON_PATH = RESOURCE_DIR  / "icon.ico"
API_BASE_URL = "http://127.0.0.1:8282"
TIMEOUT = 600  # giây - tổng hợp SRT dài có thể mất vài phút
def set_window_icon(window):
    """Đổi icon title bar + taskbar cho cửa sổ pywebview trên Windows."""
    try:
        import win32gui
        import win32api
        import win32con

        hwnd = win32gui.FindWindow(None, window.title)
        if hwnd:
            icon_flags = win32con.LR_LOADFROMFILE | win32con.LR_DEFAULTSIZE
            hicon = win32gui.LoadImage(0, ICON_PATH, win32con.IMAGE_ICON, 0, 0, icon_flags)
            win32api.SendMessage(hwnd, win32con.WM_SETICON, win32con.ICON_SMALL, hicon)
            win32api.SendMessage(hwnd, win32con.WM_SETICON, win32con.ICON_BIG, hicon)
    except Exception as e:
        print("Không đổi được icon cửa sổ:", e)
download_manager = DownloadManager()
try:
    SAMPLE_RATE = vera_tts.SAMPLE_RATE
except Exception:
    SAMPLE_RATE = 24000

output_dir_path = os.path.join( BASE_DIR, "config", "folder_config.json" )

clone_config_file = os.path.join( BASE_DIR, "config", "clone_config.json" )
def _safe_print(*args, **kwargs):
    try:
        print(*args, **kwargs)
    except UnicodeEncodeError:
        pass
class Api:

    def __init__(self):
        self._window = None
        self._last_source_path = None
        self._gen_stop = threading.Event()
        self._allow_close = False
        self._quit_prompt_open = False
        self._pending_quit_prompt = False
        self._seen_lock = threading.Lock()

    def set_window(self, window):
        self._window = window

    def quit_app(self):
        self._allow_close = True
        self._quit_prompt_open = False
        self._pending_quit_prompt = False
        if self._window:
            self._window.destroy()

    def quit_prompt_dismissed(self):
        self._quit_prompt_open = False
        self._pending_quit_prompt = False

    def consume_quit_prompt(self):
        """JS gọi định kỳ. Không được gọi evaluate_js trong sự kiện closing (sẽ đơ UI)."""
        if self._pending_quit_prompt and not self._quit_prompt_open:
            self._pending_quit_prompt = False
            self._quit_prompt_open = True
            return True
        return False

    def on_window_closing(self):
        if self._allow_close:
            return True
        try:
            url = ""
            if self._window and hasattr(self._window, "get_current_url"):
                url = self._window.get_current_url() or ""
            if "loading.html" in str(url):
                return True
            if not self._quit_prompt_open:
                self._pending_quit_prompt = True
        except Exception as e:
            _safe_print("Lỗi hỏi tắt app:", e)
            return True
        return False
    def get_remembered(self):
            """JS gọi lúc load trang login để tự điền username/password đã lưu."""
            return account.load_remember()

    def login(self, username, password, remember):
        """
        Được gọi từ JS: window.pywebview.api.login(username, password, remember)
        Trả về dict: { ok: bool, message: str }
        """
        info = account.login(username, password)

        if not info["valid"]:
            return {"ok": False, "message": info["message"] or "Sai tên đăng nhập hoặc mật khẩu."}

        ms = int(time.time() * 1000)
        is_expired = info["timeexit"] < ms

        if info["status"] and not is_expired:
            # Đăng nhập thành công
            if remember:
                account.save_remember(username, password)
            else:
                account.clear_remember()

            self._window.maximize()
            self._window.load_url(str(RESOURCE_DIR / "web" / "index.html"))
            return {"ok": True, "message": ""}

        # status=False hoặc hết hạn -> có message riêng hay message mặc định
        if info["message"]:
            return {"ok": False, "message": info["message"]}

        if not info["status"]:
            return {"ok": False, "message": "Tài khoản của bạn chưa được kích hoạt. Vui lòng liên hệ admin"}

        if is_expired:
            return {"ok": False, "message": "Phần mềm đã hết hạn. Vui lòng liên hệ admin để gia hạn nhé!"}

        return {"ok": False, "message": "Đăng nhập thất bại."}

    # ==================================================
    # GỬI SỰ KIỆN TỚI JAVASCRIPT
    # ==================================================

    def _emit(self, event, payload):
        if not self._window:
            return

        js_payload = json.dumps(payload, ensure_ascii=False)
        self._window.evaluate_js(f"window.onBackendEvent('{event}', {js_payload})")
    def time_to_seconds(self,time_str):
        h, m, s = map(int, time_str.split(":"))
        return h * 3600 + m * 60 + s
    
    def _log_debug(self, text):
        try:
            log_path = Path(BASE_DIR) / "app_debug.log"
            with open(log_path, "a", encoding="utf-8", errors="replace") as f:
                f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {text}\n")
        except Exception:
            pass
    # ==================================================
    # CHỌN FILE
    # ==================================================

    def pick_file(self):
        """Mở hộp thoại chọn file văn bản/phụ đề."""
        try:
            print("DIT ME")
            result = self._window.create_file_dialog(
                webview.OPEN_DIALOG,
                file_types=("Text and subtitle files (*.txt;*.srt;*.vtt)", "All files (*.*)"),
            )

            self._log_debug(f"pick_file result: {result}")
            print(f"pick_file result: {result}")

            if not result:
                return None

            path = result[0]
            path = unicodedata.normalize('NFC', path)   # chuẩn hoá tránh lỗi dấu tiếng Việt
            self._last_source_path = path

            p = Path(path)

            if not p.exists():
                self._log_debug(f"pick_file: file không tồn tại sau khi chọn: {path}")
                return {"error": f"File không tồn tại: {path}"}

            return {
                "path": path,
                "name": p.name,
                "size_kb": round(p.stat().st_size / 1024, 1),
            }

        except Exception as ex:
            print(f"[ERROR] pick_file: {ex}\n{traceback.format_exc()}")
            self._log_debug(f"pick_file LỖI: {ex}\n{traceback.format_exc()}")
            return {"error": str(ex)}

    def pick_audio(self):
        """Mở hộp thoại chọn file audio (dùng cho nhân bản giọng nói)."""
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            file_types=("Audio files (*.wav;*.mp3;*.m4a)", "All files (*.*)"),
        )
        if not result:
            return None

        path = result[0]
        return {
            "path": path,
            "name": Path(path).name,
            "size_kb": round(Path(path).stat().st_size / 1024, 1),
        }
    def pick_audios(self):
        """Mở hộp thoại chọn file audio (dùng cho nhân bản giọng nói)."""
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=True,
            file_types=("Audio files (*.wav;*.mp3;*.m4a)", "All files (*.*)"),
        )
        if not result:
            return None

        files = []

        for path in result:
            files.append({
                "path": path,
                "name": Path(path).name
            })
        return files
    def pick_files(self):
        """Mở hộp thoại chọn file audio (dùng cho nhân bản giọng nói)."""
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=True,
            file_types=("files (*.txt;*.srt;*.vtt;*.wav;*.mp3;*.m4a)", "All files (*.*)"),
        )
        if not result:
            return None

        files = []

        for path in result:
            p = Path(path)
            size_kb = round(p.stat().st_size / 1024, 1)
            files.append({
                "path": path,
                "name": p.name,
                "size_kb": size_kb
            })
        return files
    def pick_files_by_type(self, file_type):
        """Mở hộp thoại chọn file theo loại text hoặc audio."""

        if file_type == "text":
            file_types = (
                "Text files (*.txt;*.srt;*.vtt)",
                "All files (*.*)"
            )

        elif file_type == "audio":
            file_types = (
                "Audio files (*.wav;*.mp3;*.m4a)",
                "All files (*.*)"
            )

        else:
            raise ValueError(f"file_type không hợp lệ: {file_type}")

        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=True,
            file_types=file_types,
        )

        if not result:
            return None

        files = []

        for path in result:
            p = Path(path)

            size_kb = round(
                p.stat().st_size / 1024,
                1
            )

            files.append({
                "path": path,
                "name": p.name,
                "size_kb": size_kb
            })

        return files
    def pick_media(self):
        """Mở hộp thoại chọn nhiều file Media."""

        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=True,
            file_types=(
                "Media files (*.mp4;*.mov;*.avi;*.mkv;*.webm;*.png;*.jpg;*.jpeg)",
                "All files (*.*)"
            ),
        )

        if not result:
            return None
        self._window.evaluate_js("showMediaTableLoading(true)")
        files = []

        for path in result:
            duration = 0
            width = 0
            height = 0

            # Chỉ lấy thông tin video
            thumb = None
            if Path(path).suffix.lower() in (".mp4", ".mov", ".avi", ".mkv", ".webm"):
                try:
                    duration, width, height = audio_utils.get_video_info(path)
                    # thumb = audio_utils.get_video_thumbnail(path)
                except Exception:
                    pass

            files.append({
                "path": path,
                "name": Path(path).name,
                "size_kb": round(Path(path).stat().st_size / 1024, 1),
                "duration": audio_utils.format_duration(duration) if duration else "",
                "durationSeconds": float(duration) if duration else 0,
                "width": width,
                "height": height,
                "thumb": thumb,
                "url": "http://127.0.0.1:9876/file?path=" + quote(path),
                "files":[]
            })
        self._window.evaluate_js("showMediaTableLoading(false)")    
        return files
    def pick_output_folder(self):
        """Mở hộp thoại chọn thư mục xuất."""
        result = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        if not result:
            return None
        return result[0]

    def serve_audio(self, filepath):
        """Đọc file audio và trả về base64 data URI.

        Dùng data URI thay vì file:// vì WebView2 (Windows) chặn truy cập
        file:// khi trang đang được phục vụ qua origin http:// nội bộ.
        """
        try:
            # Chuẩn hoá Unicode (NFC) để tránh lệch tên file có dấu tiếng Việt
            filepath = unicodedata.normalize('NFC', filepath)
            path = Path(filepath)

            if not path.exists():
                # Debug: liệt kê thư mục để so sánh tên file thực tế
                parent = path.parent
                existing = []
                if parent.exists():
                    existing = [unicodedata.normalize('NFC', f) for f in os.listdir(parent)]
                return {"error": f"File not found: {filepath}", "exists": False}

            mime = mimetypes.guess_type(str(path))[0] or "audio/wav"
            data = path.read_bytes()
            b64 = base64.b64encode(data).decode("ascii")
            data_uri = f"data:{mime};base64,{b64}"

            return {"url": data_uri, "exists": True}
        except Exception as e:
            return {"error": str(e), "exists": False}
     #Serve media       
    def serve_media(self, path):

        p = Path(path)

        return {
            "url": "http://127.0.0.1:9876/file?path=" + quote(path)
        }
    def serve_thumb(self, path):

        p = Path(path)

        thumb = p.with_suffix(".jpg")

        return {
            "url": f"http://127.0.0.1:9876/thumb/{quote(thumb.name)}"
        }
    #THEM 

    def generate_thumbnails_batch(self, paths, threads=4):
        thread = threading.Thread(
            target=self._generate_thumbnails_worker,
            args=(list(paths or []), int(threads) if threads else 4),
            daemon=True,
        )
        thread.start()
        return {"started": True}

    def _generate_thumbnail_one(self, path):
        try:
            thumb_path = audio_utils.get_video_thumbnail(path)
            if not thumb_path:
                return {"error": "Không tạo được thumbnail"}
            # return self.serve_thumb(path)
            return {"url": thumb_path}
        except Exception as e:
            return {"error": str(e)}

    def _generate_thumbnails_worker(self, paths, threads=4):
        if not paths:
            return
        with ThreadPoolExecutor(max_workers=threads) as executor:
            future_to_path = {
                executor.submit(self._generate_thumbnail_one, p): p for p in paths
            }
            for future in as_completed(future_to_path):
                p = future_to_path[future]
                try:
                    result = future.result()
                except Exception as e:
                    result = {"error": str(e)}
                if self._window:
                    js = f"applyThumbnailResult({json.dumps(p)}, {json.dumps(result)})"
                    self._window.evaluate_js(js)
    #END THEM
    def get_system_fonts(self):

        font_map = {
            "Roboto-Regular": {
                "family": "Roboto",
                "weight": 400,
                "style": "normal"
            },
            "Roboto-Bold": {
                "family": "Roboto",
                "weight": 700,
                "style": "bold"
            },
            "Roboto-Italic": {
                "family": "Roboto",
                "weight": 400,
                "style": "italic"
            },
            "Anton-Regular": {
                "family": "Anton",
                "weight": 400,
                "style": "normal"
            },
            "BebasNeue-Regular": {
                "family": "BebasNeue",
                "weight": 400,
                "style": "normal"
            },
            "Sora-Regular": {
                "family": "Sora",
                "weight": 400,
                "style": "normal"
            },
            "Sora-Bold": {
                "family": "Sora",
                "weight": 700,
                "style": "bold"
            },
            "Oswald-ExtraLight": {
                "family": "Oswald",
                "weight": 200,
                "style": "extralight"
            },
            "Oswald-Light": {
                "family": "Oswald",
                "weight": 300,
                "style": "light"
            },
            "Oswald-Regular": {
                "family": "Oswald",
                "weight": 400,
                "style": "normal"
            },
            "Oswald-Medium": {
                "family": "Oswald",
                "weight": 500,
                "style": "medium"
            },
            "Oswald-SemiBold": {
                "family": "Oswald",
                "weight": 600,
                "style": "semibold"
            },
            "Oswald-Bold": {
                "family": "Oswald",
                "weight": 700,
                "style": "bold"
            },
            "Montserrat-Regular": {
                "family": "Montserrat",
                "weight": 400,
                "style": "normal"
            },
            "Montserrat-Bold": {
                "family": "Montserrat",
                "weight": 700,
                "style": "bold"
            },
            "Poppins-Regular": {
                "family": "Poppins",
                "weight": 400,
                "style": "normal"
            },
            "Poppins-Bold": {
                "family": "Poppins",
                "weight": 700,
                "style": "bold"
            },
            "Roboto-BoldItalic": {
                "family": "Roboto",
                "weight": 700,
                "style": "italic"
            },
            "Inter-Variable": {
                "family": "Inter",
                "weight": 400,
                "style": "normal"
            },
            "Roboto-Variable": {
                "family": "Roboto Variable",
                "weight": 400,
                "style": "normal"
            },
            "MTD-Fiftyes": {
                "family": "MTD-Fiftyes",
                "weight": 400,
                "style": "normal"
            },
            "TQ-Kingston": {
                "family": "TQ-Kingston",
                "weight": 400,
                "style": "normal"
            },
            "MTD-Autogate-Stamp": {
                "family": "MTD-Autogate-Stamp",
                "weight": 400,
                "style": "normal"
            },

        }


        fonts = []
        font_dirs = [FONT_DIR]
        if getattr(sys, "frozen", False):
            font_dirs += [
                str(APP_DIR / "web" / "fonts"),
                str(APP_DIR / "_internal" / "web" / "fonts"),
            ]
        seen_files = set()
        for font_dir in font_dirs:
            if not os.path.isdir(font_dir):
                continue
            try:
                names = os.listdir(font_dir)
            except OSError:
                continue
            for file in names:
                if not file.lower().endswith((".ttf", ".otf")):
                    continue
                full = os.path.normpath(os.path.join(font_dir, file))
                key_seen = full.lower()
                if key_seen in seen_files:
                    continue
                seen_files.add(key_seen)

                key = os.path.splitext(file)[0]
                config = font_map.get(key)

                if config:
                    fonts.append({
                        "name": config["family"],
                        "weight": config["weight"],
                        "style": config["style"],
                        "path": full,
                    })
                else:
                    fonts.append({
                        "name": key,
                        "weight": 400,
                        "style": "normal",
                        "path": full,
                    })

        return fonts
    def get_font_url(self, path):

        p = Path(path)
        return {
            "url": "http://127.0.0.1:9876/file?path=" + quote(path)
        }    
    # END TẠO HÀNG LOẠT SUB (BATCH GENERATION)

    def paraphrase_file(self, source_path, model_name=None):
        PARAPHRASE_DIR.mkdir(parents=True, exist_ok=True)

        result = paraphrase_srt.paraphrase_source_file(
            source_path,
            str(PARAPHRASE_DIR),
            model_name=model_name or paraphrase_srt.MODEL_NAME,
        )

        return {
            "txt_path": result["txt_path"],
            "srt_path": result["srt_path"],
            "txt_name": Path(result["txt_path"]).name,
            "srt_name": Path(result["srt_path"]).name if result.get("srt_path") else None,
            }

    def _paraphrase_worker(self, source_path, model_name):
        try:
            PARAPHRASE_DIR.mkdir(parents=True, exist_ok=True)
            self._emit("paraphrase_status", {"message": "Đang viết lại nội dung bằng AI (Ollama)…"})

            result = paraphrase_srt.paraphrase_source_file(
                source_path,
                str(PARAPHRASE_DIR),
                model_name=model_name or paraphrase_srt.MODEL_NAME,
            )

            self._emit("paraphrase_done", {
                "txt_path": result["txt_path"],
                "srt_path": result["srt_path"],
                "txt_name": Path(result["txt_path"]).name,
                "srt_name": Path(result["srt_path"]).name,
            })
        except Exception as e:
            traceback.print_exc()
            self._emit("paraphrase_error", {"message": str(e)})

    # ==================================================
    # TẠO HÀNG LOẠT SUB (BATCH GENERATION)
    # ==================================================
    #   
    def generate_batch(self, config):
        self._gen_stop.clear()
        thread = threading.Thread(
            target=self._generate_batch_worker,
            args=(config,),
            daemon=True
        )
        thread.start()
        return {"started": True}

    def stop_generate_batch(self):
        self._gen_stop.set()
        self._emit("status", {"message": "Đã nhận lệnh dừng. Đợi phiên bản đang chạy xong rồi dừng."})
        return True

    
    def _generate_batch_worker(self, config):
        files = config.get("files", [])
        if not files:
            single = config.get("source_path")
            if single:
                files = [{"path": single, "name": Path(single).name}]

        if not files:
            self._emit("error", {"message": "Không nhận được danh sách file từ giao diện."})
            return

        voice = config.get("voice", "Minh Đức")
        speed = float(config.get("speed", 1.0))
        pitch = float(config.get("pitch", 0.0))
        count = max(1, int(config.get("count", 1)))
        name_pattern = config.get("name_pattern") or "{file}_{index}"
        target_duration = config.get("target_duration")

        enable_clone = bool(config.get("enable_clone", False))
        clone_audio = config.get("clone_audio")
        ref_text = config.get("ref_text", "").strip()
        enable_ai_rewrite = bool(config.get("enable_ai_rewrite", False))
        enable_clone_save = bool(config.get("enable_clone_save",False))
        nameCloneSave = config.get("nameCloneSave","NameVoice")
        desCLoneSave = config.get("desCLoneSave","Mô Tả Voice")
        language = config.get("language","vi")
        num_step = config.get("num_step",16)
        instruct = str(config.get("instruct") or "").strip()
        # ====== SỐ LUỒNG CHO FILE (không còn dùng cho count nữa) ======
        if enable_ai_rewrite:
            file_threads = 1
            self._emit("status", {
                "message": "Đã bật viết lại bằng AI — chạy tuần tự 1 luồng để tránh xung đột."
            })
        else:
            file_threads = max(1, min(16, self._batch_thread_count(config, 1)))
        # =================================================================

        if enable_clone:
            if not clone_audio:
                self._emit("error", {"message": "Voice cloning enabled but no audio sample selected."})
                return
            if not ref_text:
                self._emit("error", {"message": "Voice cloning requires reference text."})
                return

        voice_subtitle = None
        if os.path.exists(output_dir_path):
            with open(output_dir_path, "r", encoding="utf-8") as f:
                configFoder = json.load(f)
            voice_subtitle = configFoder.get("voice_subtitle")
        output_dir = Path(voice_subtitle) if voice_subtitle else OUTPUT_DIR
        output_dir.mkdir(parents=True, exist_ok=True)
        TMP_DIR.mkdir(parents=True, exist_ok=True)
        if enable_ai_rewrite:
            PARAPHRASE_DIR.mkdir(parents=True, exist_ok=True)

        total_files = len(files)
        total_versions_overall = total_files * count   # tổng số phiên bản trên TOÀN BỘ batch
        completed_versions_overall = 0
        progress_lock = threading.Lock()   # đảm bảo cộng dồn an toàn khi nhiều file chạy song song

        self._emit("batch_start", {"total_files": total_files, "total_versions": total_versions_overall})

        def process_one_file(file_index, file_info):
            original_path = file_info.get("path")
            original_name = file_info.get("name") or Path(original_path).name

            if self._gen_stop.is_set():
                return {"success": False, "stopped": True, "file_name": original_name}

            self._emit("file_start", {
                "file_index": file_index,
                "total_files": total_files,
                "file_name": original_name,
            })

            try:
                # Nếu KHÔNG bật AI rewrite, cues/script gốc giống nhau cho mọi version -> load 1 lần
                base_cues = None
                base_script_text = None
                original_ext = Path(original_path).suffix.lower()
                if not enable_ai_rewrite:
                    source_stem = unicodedata.normalize('NFC', Path(original_path).stem)
                    base_cues = subtitle_utils.load_cues(original_path)
                    base_script_text = subtitle_utils.full_script_text(base_cues)

                # ====== VÒNG LẶP TUẦN TỰ QUA TỪNG PHIÊN BẢN ======
                for index in range(1, count + 1):
                    if self._gen_stop.is_set():
                        self._emit("status", {
                            "message": f"[{file_index}/{total_files}] Đã dừng: {original_name}",
                            "file_name": original_name,
                        })
                        return {"success": False, "stopped": True, "file_name": original_name}

                    idx_str = str(index).zfill(2)

                    # ---- Mỗi phiên bản viết lại AI riêng (nếu bật) ----
                    if enable_ai_rewrite:
                        self._emit("status", {
                            "message": f"[{file_index}/{total_files}] Đang viết lại nội dung bằng AI (phiên bản {index}/{count})…",
                            "file_name": original_name,
                        })
                        result = paraphrase_srt.paraphrase_source_file(
                            original_path,
                            str(PARAPHRASE_DIR),
                            model_name=paraphrase_srt.MODEL_NAME,
                        )
                        source_path = result["txt_path"]
                        self._emit("status", {
                            "message": f"[{file_index}/{total_files}] Viết lại AI hoàn tất (phiên bản {index}/{count}).",
                            "file_name": original_name,
                        })
                        source_stem = unicodedata.normalize('NFC', Path(source_path).stem)
                        cues = subtitle_utils.load_cues(source_path)
                        script_text = subtitle_utils.full_script_text(cues)
                        # AI rewrite luôn xuất phát từ text -> luôn cần build lại SRT
                        need_build_srt = True
                        # Nguồn để TTS đọc phải là bản ĐÃ viết lại, không phải file gốc
                        synth_source_path = source_path
                    else:
                        cues = base_cues
                        script_text = base_script_text
                        # Chỉ build lại SRT nếu nguồn KHÔNG PHẢI là .srt (vd: .txt)
                        if target_duration:
                            need_build_srt= True
                        else:
                            need_build_srt = original_ext != ".srt"

                        # Không AI rewrite -> TTS đọc từ file gốc
                        synth_source_path = original_path

                    stem = name_pattern.replace("{index}", idx_str) \
                                        .replace("{voice}", voice) \
                                        .replace("{file}", source_stem)
                    stem = unicodedata.normalize('NFC', Path(stem).stem)

                    version_base_wav = TMP_DIR / f"version_{file_index}_{idx_str}.wav"


                    if enable_clone:
                        self._emit("status", {
                            "message": f"[{file_index}/{total_files}] Đang nhân bản giọng nói {index}/{count}…",
                            "file_name": original_name,
                        })
                    else:
                        self._emit("status", {
                            "message": f"[{file_index}/{total_files}] Đang tổng hợp phiên bản {index}/{count}…",
                            "file_name": original_name,
                        })
                    wav_out = output_dir / f"{stem}.wav"
                    srt_out = output_dir / f"{stem}.srt"
                    vera_tts.synthesize_srt(
                        srt_path=synth_source_path,
                        voice=voice,
                        enable_clone_save=enable_clone_save,
                        nameCloneSave=nameCloneSave if enable_clone_save else None,
                        desCLoneSave=desCLoneSave if enable_clone_save else None, 
                        out_wav_path=str(version_base_wav),
                        ref_audio=clone_audio if enable_clone else None,
                        ref_text=ref_text if enable_clone else None,
                        language= language if language else "vi",
                        num_step=num_step,
                        instruct=instruct or None,
                        # speed=1.0,
                        # pitch=0
                    )
                    if self._gen_stop.is_set():
                        try:
                            Path(version_base_wav).unlink(missing_ok=True)
                        except Exception:
                            pass
                        return {"success": False, "stopped": True, "file_name": original_name}
                    # vera_tts.synthesize(
                    #     text=script_text,
                    #     # voice=voice,
                    #     out_wav_path=str(version_base_wav),
                    #     ref_audio=clone_audio if enable_clone else None,
                    #     ref_text=ref_text if enable_clone else None,
                    # )

                    version_base_duration = audio_utils.probe_duration_seconds(str(version_base_wav))
                    effective_speed = speed
                    if target_duration:
                        effective_speed = audio_utils.speed_for_target_duration(
                            version_base_duration, float(target_duration)
                        )



                    audio_utils.render_audio(
                        str(version_base_wav),
                        str(wav_out),
                        speed=effective_speed,
                        pitch_semitones=pitch,
                        sample_rate=SAMPLE_RATE,
                    )

                    # ---- SRT: chỉ build lại khi là AI rewrite hoặc nguồn là .txt ----
                    # Nếu nguồn gốc đã là .srt (và không bật AI rewrite) -> giữ nguyên file SRT gốc
                    if need_build_srt:
                        final_duration = audio_utils.probe_duration_seconds(str(wav_out))
                        srt_text = subtitle_utils.build_srt(cues, final_duration)
                        srt_out.write_text(srt_text, encoding="utf-8")
                    else:
                        shutil.copyfile(original_path, srt_out)

                    # ====== CẬP NHẬT TIẾN TRÌNH TỔNG (AN TOÀN VỚI ĐA LUỒNG) ======
                    nonlocal completed_versions_overall
                    with progress_lock:
                        completed_versions_overall += 1
                        done_overall = completed_versions_overall
                    # ================================================================

                    self._emit("progress", {
                        "file_index": file_index,
                        "total_files": total_files,
                        "file_name": original_name,
                        "done": index,
                        "total": count,
                        "done_overall": done_overall,
                        "total_overall": total_versions_overall,
                        "files": [wav_out.name, srt_out.name],
                        "output_dir": str(output_dir),
                    })

                self._emit("file_done", {
                    "file_index": file_index,
                    "total_files": total_files,
                    "file_name": original_name,
                })
                try:
                    Path(version_base_wav).unlink()
                except FileNotFoundError:
                    pass  
                return {"success": True, "file_name": original_name}

            except Exception as e:
                traceback.print_exc()
                self._emit("file_error", {
                    "file_index": file_index,
                    "total_files": total_files,
                    "file_name": original_name,
                    "message": str(e),
                })
                return {"success": False, "file_name": original_name, "message": str(e)}

        # ====== CHẠY ĐA LUỒNG THEO FILE (file_threads file cùng lúc) ======
        files_done = 0
        files_error = 0

        with ThreadPoolExecutor(max_workers=file_threads) as pool:
            futures = {
                pool.submit(process_one_file, i, file_info): i
                for i, file_info in enumerate(files, start=1)
            }
            for future in as_completed(futures):
                result = future.result()
                if result.get("stopped"):
                    pass
                elif result["success"]:
                    files_done += 1
                else:
                    files_error += 1
        # ====================================================================
        if enable_ai_rewrite:
            paraphrase_srt.unload_model(paraphrase_srt.MODEL_NAME)
        if self._gen_stop.is_set():
            self._emit("cancelled", {
                "output_dir": str(output_dir),
                "total_files": total_files,
                "success_count": files_done,
                "error_count": files_error,
            })
            return
        self._emit("done", {
            "output_dir": str(output_dir),
            "total_files": total_files,
            "success_count": files_done,
            "error_count": files_error,
            "total_versions": total_versions_overall,
        })
    
    # END TẠO HÀNG LOẠT SUB (BATCH GENERATION)
    # ==================================================    
    def _channel_folder_from_link(self, link):
        match = re.search(r"channels/([A-Za-z0-9_-]+)", str(link or ""), re.I)
        if not match:
            return ""
        name = match.group(1).strip()
        if not name or name.lower() in ("videos", "shorts"):
            return ""
        return name

    def _urls_from_scan_api(self, api_url):
        api_url = str(api_url).strip()
        channel = self._channel_folder_from_link(api_url)
        resp = requests.get(api_url, timeout=40)
        resp.raise_for_status()
        data = resp.json()
        items = data.get("items") if isinstance(data, dict) else data
        total = 0
        if isinstance(data, dict):
            try:
                total = int(data.get("total") or 0)
            except (TypeError, ValueError):
                total = 0
        if not isinstance(items, list):
            return [], channel, total
        urls = []
        seen = set()
        for item in items:
            if not isinstance(item, dict):
                continue
            url = str(item.get("url") or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            urls.append(url)
        return urls, channel, total

    def _api_limit_value(self, api_url):
        query = dict(parse_qsl(urlparse(str(api_url or "")).query, keep_blank_values=True))
        try:
            limit = int(query.get("limit") or 5)
        except (TypeError, ValueError):
            limit = 5
        return max(1, limit)

    def _api_with_limit(self, api_url, limit):
        parts = urlparse(str(api_url or ""))
        query = dict(parse_qsl(parts.query, keep_blank_values=True))
        query["limit"] = str(max(1, int(limit)))
        return urlunparse(parts._replace(query=urlencode(query)))

    def _daily_pick_path(self):
        return os.path.join(BASE_DIR, "config", "scan_daily_pick.json")

    def _daily_urls_today(self, channel):
        key = str(channel or "").strip()
        if not key:
            return []
        path = self._daily_pick_path()
        if not os.path.exists(path):
            return []
        today = datetime.now().strftime("%Y-%m-%d")
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return []
        row = data.get(key) if isinstance(data, dict) else None
        if not isinstance(row, dict) or str(row.get("date") or "") != today:
            return []
        urls = row.get("urls")
        if isinstance(urls, list):
            return [str(u).strip() for u in urls if str(u).strip()]
        one = str(row.get("url") or "").strip()
        return [one] if one else []

    def _mark_daily_picks(self, channel, urls):
        key = str(channel or "").strip()
        picked = [str(u).strip() for u in (urls or []) if str(u).strip()]
        if not key or not picked:
            return
        path = self._daily_pick_path()
        with self._seen_lock:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            data = {}
            if os.path.exists(path):
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        loaded = json.load(f)
                    if isinstance(loaded, dict):
                        data = loaded
                except Exception:
                    data = {}
            today = datetime.now().strftime("%Y-%m-%d")
            row = data.get(key) if isinstance(data.get(key), dict) else {}
            current = []
            if str(row.get("date") or "") == today:
                saved = row.get("urls")
                if isinstance(saved, list):
                    current = [str(u).strip() for u in saved if str(u).strip()]
                else:
                    one = str(row.get("url") or "").strip()
                    if one:
                        current = [one]
            for url in picked:
                if url not in current:
                    current.append(url)
            data[key] = {"date": today, "urls": current}
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)

    def _urls_for_one_api(self, api_url, seen_urls, per_day):
        try:
            quota = int(per_day or 5)
        except (TypeError, ValueError):
            quota = 5
        quota = max(1, min(100, quota))
        label = self._channel_folder_from_link(api_url) or api_url
        have_urls = [u for u in self._daily_urls_today(label) if u in seen_urls]
        have = len(have_urls)
        if have >= quota:
            verb = "render" if getattr(self, "_quota_counts_render", False) else "tải"
            self.on_download_log(label + ": hôm nay đã " + verb + " đủ " + str(quota) + " video.")
            return [], self._channel_folder_from_link(api_url), ""
        need = quota - have
        base_limit = self._api_limit_value(api_url)
        limit = max(base_limit, need)
        try:
            urls, channel, total = self._urls_from_scan_api(self._api_with_limit(api_url, limit))
        except Exception as ex:
            return [], "", str(ex)
        if channel:
            label = channel
        if limit > base_limit:
            self.on_download_log(label + ": cần " + str(need) + " video. Tăng limit=" + str(limit) + ".")
        already = set(have_urls)
        fresh = [u for u in urls if u not in seen_urls and u not in already]
        if total > 0:
            cap = total
        elif len(urls) < limit:
            cap = len(urls)
        else:
            cap = max(limit, base_limit * 40)
        while len(fresh) < need and limit < cap:
            next_limit = min(cap, max(limit + base_limit, limit + (need - len(fresh))))
            if next_limit <= limit:
                break
            limit = next_limit
            self.on_download_log(label + ": chưa đủ video chưa render. Tăng limit=" + str(limit) + ".")
            try:
                urls, channel, total = self._urls_from_scan_api(self._api_with_limit(api_url, limit))
            except Exception as ex:
                return [], channel, str(ex)
            if channel:
                label = channel
            if total > cap:
                cap = total
            if len(urls) < limit:
                cap = len(urls)
            fresh = [u for u in urls if u not in seen_urls and u not in already]
        chosen = fresh[:need]
        if not chosen:
            self.on_download_log(label + ": không còn video chưa render.")
            return [], channel, ""
        verb = "render" if getattr(self, "_quota_counts_render", False) else "tải"
        message = (
            label + ": lấy " + str(len(chosen)) + " video. Hôm nay đã "
            + verb + " " + str(have) + "/" + str(quota) + "."
        )
        if len(chosen) < need:
            message += " Không còn video chưa render."
        self.on_download_log(message)
        return chosen, channel, ""

    def _scan_api_lines(self, scan_api):
        if isinstance(scan_api, (list, tuple)):
            raw = scan_api
        else:
            raw = str(scan_api or "").splitlines()
        lines = []
        seen = set()
        for item in raw:
            api = str(item or "").strip()
            if not api or api in seen:
                continue
            seen.add(api)
            lines.append(api)
        return lines

    def _urls_from_scan_apis(self, api_urls, threads, seen_urls, per_day):
        workers = max(1, min(len(api_urls), int(threads or 1)))
        self.on_download_log(
            "Quét " + str(len(api_urls)) + " API với " + str(workers) + " luồng."
        )
        found = []
        url_dirs = {}
        failed = 0
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(self._urls_for_one_api, api, seen_urls, per_day): api for api in api_urls
            }
            for fut in as_completed(futures):
                api = futures[fut]
                try:
                    urls, channel, err = fut.result()
                except Exception as ex:
                    failed += 1
                    self.on_download_log("❌ Không quét được API: " + api + " | " + str(ex))
                    continue
                if err:
                    failed += 1
                    self.on_download_log("❌ Không quét được API: " + api + " | " + err)
                    continue
                for url in urls:
                    if channel and not url_dirs.get(url):
                        url_dirs[url] = channel
                    found.append(url)
        merged = []
        seen = set()
        for url in found:
            if url in seen:
                continue
            seen.add(url)
            link_channel = self._channel_folder_from_link(url)
            if link_channel and not url_dirs.get(url):
                url_dirs[url] = link_channel
            merged.append(url)
        return merged, failed, url_dirs

    def _seen_urls_path(self):
        return os.path.join(BASE_DIR, "config", "scan_seen_urls.json")

    def _load_seen_urls(self):
        path = self._seen_urls_path()
        if not os.path.exists(path):
            return set()
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                return set(str(x) for x in data if str(x).strip())
        except Exception:
            pass
        return set()

    def _on_download_saved(self, url):
        self._mark_seen_url(url)
        if getattr(self, "_quota_counts_render", False):
            return
        channel = str((getattr(self, "_quota_url_dirs", {}) or {}).get(url) or "").strip()
        if channel:
            self._mark_daily_picks(channel, [url])

    def _count_rendered_video(self, media):
        source_url = str((media or {}).get("source_url") or "").strip()
        source_path = str((media or {}).get("path") or "").strip()
        channel = data_queue.channel_from_path(source_path)
        if not channel or not source_url:
            return
        self._mark_daily_picks(channel, [source_url])

    def _mark_seen_url(self, url):
        url = str(url or "").strip()
        if not url:
            return
        path = self._seen_urls_path()
        with self._seen_lock:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            seen = self._load_seen_urls()
            if url in seen:
                return
            seen.add(url)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(sorted(seen), f, ensure_ascii=False, indent=2)

    def _remember_scan_video_api(self, api_url, auto=None, minutes=None):
        cfg = self.get_folder_config() or {}
        if not isinstance(cfg, dict):
            cfg = {}
        cfg["scan_video_api"] = str(api_url or "").strip()
        cfg.pop("scan_video_auto", None)
        if minutes is not None:
            try:
                cfg["scan_video_minutes"] = max(1, min(1440, int(minutes)))
            except Exception:
                pass
        self.save_folder_config(cfg)

    def _remember_download_proxies(self, proxies, enabled=None):
        cfg = self.get_folder_config() or {}
        if not isinstance(cfg, dict):
            cfg = {}
        lines = []
        seen = set()
        for item in proxies or []:
            proxy = normalize_socks5_proxy(item)
            if not proxy or proxy in seen:
                continue
            seen.add(proxy)
            lines.append(proxy)
        cfg["download_proxies"] = "\n".join(lines)
        if enabled is not None:
            cfg["download_use_proxy"] = bool(enabled)
        self.save_folder_config(cfg)

    def _remember_render_per_day(self, per_day):
        cfg = self.get_folder_config() or {}
        if not isinstance(cfg, dict):
            cfg = {}
        try:
            cfg["render_per_channel_day"] = max(1, min(100, int(per_day)))
        except (TypeError, ValueError):
            cfg["render_per_channel_day"] = 5
        self.save_folder_config(cfg)

    #Download video
    def start_download(self, config):
        config = dict(config or {})
        with download_manager.saved_files_lock:
            download_manager.saved_files.clear()
        urls = [str(u).strip() for u in (config.get("urls") or []) if str(u).strip()]
        auto_scan = bool(config.get("auto_scan"))
        self._quota_counts_render = bool(config.get("auto_render"))
        link_mode = bool(config.get("link_mode")) and not auto_scan and bool(urls)
        scan_apis = [] if link_mode else self._scan_api_lines(config.get("scan_api"))
        try:
            scan_threads = max(1, min(100, int(config.get("threads") or 1)))
        except Exception:
            scan_threads = 1
        config["threads"] = scan_threads
        url_dirs = {}
        seen_urls = self._load_seen_urls()
        if link_mode:
            self.on_download_log(
                "Tải theo danh sách link, "
                + str(scan_threads)
                + " luồng."
            )
        if scan_apis:
            self._remember_scan_video_api("\n".join(scan_apis))
            try:
                per_day = int(config.get("render_per_day") or 0)
            except (TypeError, ValueError):
                per_day = 0
            if per_day < 1:
                saved = self.get_folder_config() or {}
                try:
                    per_day = int(saved.get("render_per_channel_day") or 5)
                except (TypeError, ValueError):
                    per_day = 5
            per_day = max(1, min(100, per_day))
            self._remember_render_per_day(per_day)
            found, failed, url_dirs = self._urls_from_scan_apis(scan_apis, scan_threads, seen_urls, per_day)
            extra = [] if auto_scan else [u for u in urls if u not in seen_urls]
            urls = found + extra
            if not urls:
                if failed and not found:
                    self.on_download_log("❌ Không quét được API nào.")
                else:
                    self.on_download_log("Không có video chưa render.")
                self.on_download_done()
                return False
            self.on_download_log("Sẽ tải " + str(len(found)) + " video chưa render.")
        else:
            urls = [u for u in urls if u not in seen_urls]
        merged = []
        seen = set()
        for url in urls:
            if not url or url in seen:
                continue
            seen.add(url)
            merged.append(url)
        urls = merged
        if not urls:
            self.on_download_log("Không có video mới." if seen_urls else "❌ API không có link video.")
            self.on_download_done()
            return False
        if not link_mode:
            for url in urls:
                link_channel = self._channel_folder_from_link(url)
                if link_channel and not url_dirs.get(url):
                    url_dirs[url] = link_channel
        config["urls"] = urls
        config["url_dirs"] = url_dirs
        self._quota_url_dirs = dict(url_dirs)
        self._remember_download_proxies(
            config.get("proxy_lines") if config.get("proxy_lines") is not None else config.get("proxies"),
            config.get("use_proxy"),
        )
        out_dir_download = None
        if os.path.exists(output_dir_path):
            with open(
                output_dir_path,
                "r",
                encoding="utf-8"
            ) as f:

                configFoder = json.load(f)


            # lấy key render_video
            out_dir_download = configFoder.get("download_video")
        threading.Thread(

            target=download_manager.start,

            args=(

                config["urls"],
                out_dir_download,
                config["threads"],
                config.get("platform"),
                config.get("encode_mode", "gpu"),
                config.get("url_dirs") or {},
                config.get("proxies") or [],

            ),

            daemon=True

        ).start()

        return True

    def stop_download(self):

        download_manager.stop()

        return True
    # ==================================================
    # DOWNLOAD CALLBACK
    # ==================================================

    def on_download_log(self, message):

        if not self._window:
            return

        self._window.evaluate_js(
            f"appendDownloadLog({json.dumps(message)});"
        )


    def on_download_file_progress(self, title, percent):
        if not self._window:
            return
        self._window.evaluate_js(
            "updateDownloadFileStatus({0}, {1});".format(
                json.dumps(str(title or "video")),
                int(percent),
            )
        )

    def on_download_progress(self, progress, completed, total):

        if not self._window:
            return

        self._window.evaluate_js(
            f"updateDownloadProgress({progress}, {completed}, {total});"
        )

    def on_highlight_progress(self, percent, label):
        if not self._window:
            return
        self._window.evaluate_js(
            "updateHighlightProgress({0}, {1});".format(int(percent), json.dumps(str(label)))
        )

    def on_download_done(self):
        if not self._window:
            return
        with download_manager.saved_files_lock:
            sources = getattr(download_manager, "saved_sources", {})
            files = [
                {"path": path, "url": sources.get(path, "")}
                for path in download_manager.saved_files
            ]
        self._window.evaluate_js(
            "onDownloadFinished(" + json.dumps(files, ensure_ascii=False) + ");"
        )

    def set_download_auto_render(self, enabled):
        data = data_queue.load(APP_DIR)
        data["download_auto_render"] = bool(enabled)
        return data_queue.save(APP_DIR, data)

    def set_render_crop(self, enabled):
        data = data_queue.load(APP_DIR)
        data["render_crop"] = bool(enabled)
        return data_queue.save(APP_DIR, data)

    def set_render_random_cut(self, enabled):
        data = data_queue.load(APP_DIR)
        data["render_random_cut"] = bool(enabled)
        return data_queue.save(APP_DIR, data)

    def set_render_color(self, enabled):
        data = data_queue.load(APP_DIR)
        data["render_color"] = bool(enabled)
        return data_queue.save(APP_DIR, data)

    def set_render_volume(self, enabled):
        data = data_queue.load(APP_DIR)
        data["render_volume"] = bool(enabled)
        return data_queue.save(APP_DIR, data)

    def set_render_combo_a(self, enabled):
        data = data_queue.load(APP_DIR)
        data["render_combo_a"] = bool(enabled)
        return data_queue.save(APP_DIR, data)

    def set_render_highlight(self, enabled):
        data = data_queue.load(APP_DIR)
        data["render_highlight"] = bool(enabled)
        return data_queue.save(APP_DIR, data)

    def set_render_two_screen(self, enabled):
        data = data_queue.load(APP_DIR)
        data["render_two_screen"] = bool(enabled)
        return data_queue.save(APP_DIR, data)

    def set_highlight_volume(self, enabled):
        data = data_queue.load(APP_DIR)
        data["highlight_volume"] = bool(enabled)
        return data_queue.save(APP_DIR, data)

    def set_highlight_score(self, score):
        data = data_queue.load(APP_DIR)
        try:
            value = float(score)
        except (TypeError, ValueError):
            value = 0.5
        data["highlight_score"] = max(0.1, min(1.0, int(value * 10 + 0.5) / 10))
        return data_queue.save(APP_DIR, data)

    def set_highlight_seconds(self, seconds):
        data = data_queue.load(APP_DIR)
        try:
            value = int(seconds)
        except (TypeError, ValueError):
            value = 60
        data["highlight_seconds"] = max(1, min(600, value))
        return data_queue.save(APP_DIR, data)
    #End Download       
    #Begin Render Studio  
    
    def stop_render_studio_batch(self):
        """Gọi từ JS khi người dùng bấm nút Stop."""
        video_utils.stop_all_jobs()
        return True  
    #END STOP CROP  
    def generate_crop_batch(self, config):
        video_utils.reset_stop_flag()   # cho phép chạy batch mới sau khi đã stop trước đó

        crops = config.get("crops") or []
        crop = config.get("crop")
        out_dir_crop = None
        is_creat_out_dir = None
        if os.path.exists(output_dir_path):
            with open(output_dir_path, "r", encoding="utf-8") as f:
                configFoder = json.load(f)
            out_dir_crop = configFoder.get("crop_video")
            is_creat_out_dir = configFoder.get("auto_sub_folder", False)

        files = config.get("files", [])
        if not crops and (not crop or not crop.get("enabled")):
            if not any((m or {}).get("crops") for m in files):
                return {"success": False, "message": "Chưa có layer Crop trên timeline."}

        if not files:
            return {"success": False, "message": "Không có video."}

        threads = self._batch_thread_count(config, 1)
        results = []
        output_dir = Path(out_dir_crop) if out_dir_crop else OUTPUT_DIR
        if is_creat_out_dir:
            sub_folder_name = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_dir = output_dir / sub_folder_name

        output_dir.mkdir(parents=True, exist_ok=True) 
        total = len(files)
        completed = 0
        with ThreadPoolExecutor(max_workers=threads) as executor:
            futures = [
                executor.submit(
                    self._crop_one_video, media, crop, output_dir,
                    config.get("render_option", "0"),
                    media.get("crops") if media.get("crops") is not None else crops,
                    config.get("width"),
                    config.get("height"),
                    bool(config.get("use_source_size")),
                )
                for media in files
            ]

            for future in as_completed(futures):
                result = future.result()
                results.append(result)
                completed += 1

                if result.get("stopped"):
                    continue  # không cập nhật progress khi bị dừng

                progress = int(completed * 100 / total)
                self._window.evaluate_js(
                    f"updateCropProgress({progress}, {completed}, {total});"
                )

        return {"success": True, "results": results}
    #CROP ONE          
    def _crop_one_video(self, media, crop, output_dir, option, crops=None, target_w=None, target_h=None, use_source_size=False):
        try:
            if crops:
                result = video_utils.crop_segments_concat(
                    option=option,
                    input_path=media["path"],
                    output_path=output_dir,
                    crops=crops,
                    video_w=media["width"],
                    video_h=media["height"],
                    target_w=target_w,
                    target_h=target_h,
                    use_source_size=use_source_size,
                )
            else:
                result = video_utils.crop_video(
                    option=option,
                    input_path=media["path"],
                    output_path=output_dir,
                    crop=crop,
                    video_w=media["width"],
                    video_h=media["height"]
                )

            if result.get("stopped"):
                # Bị dừng chủ động -> không hiện thông báo gì cả
                self._window.evaluate_js(
                    f'updateMediaStatus({json.dumps(media["path"])}, "Đã dừng. Chờ xử lý", "");'
                )
                return result

            if result["success"]:
                self._window.evaluate_js(
                    f'updateMediaStatusRender({json.dumps(media["path"])}, "Crop video hoàn tất", "success", {json.dumps(result["output"])});'
                )
            else:
                short_error = video_utils.extract_ffmpeg_error(result["message"])
                self._window.evaluate_js(
                    f'updateMediaStatus({json.dumps(media["path"])}, {json.dumps(short_error)}, "error");'
                )

            return result

        except Exception as ex:
            # Không show lỗi nếu đang trong quá trình dừng
            if video_utils.is_stopping():
                return {"success": False, "message": str(ex), "stopped": True}

            self._window.evaluate_js(
                f'updateMediaStatus({json.dumps(media["path"])}, {json.dumps(str(ex))}, "error");'
            )
            return {"success": False, "message": str(ex)}
    #STOP CROP            
 


    def generate_export_image_batch(self, config):
        video_utils.reset_stop_flag()   # cho phép chạy batch mới sau khi đã stop trước đó
        out_dir_export_image = None
        is_creat_out_dir = None
        if os.path.exists(output_dir_path):
            with open(output_dir_path, "r", encoding="utf-8") as f:
                configFoder = json.load(f)
            out_dir_export_image = configFoder.get("frame_image")
            is_creat_out_dir = configFoder.get("auto_sub_folder", False)
        files = config.get("files", [])
        if not files:
            return {"success": False, "message": "Không có video."}

        threads = self._batch_thread_count(config, 1)
        results = []
        output_dir = Path(out_dir_export_image) if out_dir_export_image else OUTPUT_DIR
        if is_creat_out_dir:
            sub_folder_name = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_dir = output_dir / sub_folder_name

        output_dir.mkdir(parents=True, exist_ok=True) 
        total = len(files)
        completed = 0
        with ThreadPoolExecutor(max_workers=threads) as executor:
            futures = [
                executor.submit(
                    self._export_image_one, media, output_dir,
                    config.get("render_option", "0"),is_creat_out_dir
                )
                for media in files
            ]

            for future in as_completed(futures):
                result = future.result()
                results.append(result)
                completed += 1

                if result.get("stopped"):
                    continue  # không cập nhật progress khi bị dừng

                progress = int(completed * 100 / total)
                self._window.evaluate_js(
                    f"updateCropProgress({progress}, {completed}, {total});"
                )

        return {"success": True, "results": results}
    #CROP ONE          
    def _export_image_one(self, media, output_dir, option, is_creat_out_dir):
        try:
            if is_creat_out_dir:
                input_file = Path(media["path"])
                sub_folder_name = input_file.stem + "_" + datetime.now().strftime("%Y%m%d_%H%M%S")
                output_dir = output_dir / sub_folder_name
            output_dir.mkdir(parents=True, exist_ok=True)     
            result = video_utils.export_image(
                option=option,
                input_path=media["path"],
                output_path=output_dir,
            )

            if result.get("stopped"):
                # Bị dừng chủ động -> không hiện thông báo gì cả
                self._window.evaluate_js(
                    f'updateMediaStatus({json.dumps(media["path"])}, "Đã dừng. Chờ xử lý", "");'
                )
                return result

            if result["success"]:
                self._window.evaluate_js(
                    f'updateMediaStatusExport({json.dumps(media["path"])}, "Xuất hình ảnh hoàn tất", "success", {json.dumps(result["output"])});'
                )
            else:
                short_error = video_utils.extract_ffmpeg_error(result["message"])
                self._window.evaluate_js(
                    f'updateMediaStatusExport({json.dumps(media["path"])}, {json.dumps(short_error)}, "error", null);'
                )

            return result

        except Exception as ex:
            # Không show lỗi nếu đang trong quá trình dừng
            if video_utils.is_stopping():
                return {"success": False, "message": str(ex), "stopped": True}

            self._window.evaluate_js(
                f'updateMediaStatus({json.dumps(media["path"])}, {json.dumps(str(ex))}, "error");'
            )
            return {"success": False, "message": str(ex)}
    #STOP CROP            
    # def stop_image_batch(self):
    #     """Gọi từ JS khi người dùng bấm nút Stop."""
    #     video_utils.stop_all_jobs()
    #     return True  
    def generate_export_auido_batch(self, config):
            video_utils.reset_stop_flag()   # cho phép chạy batch mới sau khi đã stop trước đó
            out_dir_export_audio = None
            is_creat_out_dir = None
            if os.path.exists(output_dir_path):
                with open(output_dir_path, "r", encoding="utf-8") as f:
                    configFoder = json.load(f)
                out_dir_export_audio = configFoder.get("audio")
                is_creat_out_dir = configFoder.get("auto_sub_folder", False)
            files = config.get("files", [])
            if not files:
                return {"success": False, "message": "Không có video."}

            threads = self._batch_thread_count(config, 1)
            results = []
            output_dir = Path(out_dir_export_audio) if out_dir_export_audio else OUTPUT_DIR
            if is_creat_out_dir:
                sub_folder_name = datetime.now().strftime("%Y%m%d_%H%M%S")
                output_dir = output_dir / sub_folder_name

            output_dir.mkdir(parents=True, exist_ok=True) 
            total = len(files)
            completed = 0
            with ThreadPoolExecutor(max_workers=threads) as executor:
                futures = [
                    executor.submit(
                        self._export_audio_one, media, output_dir,
                        config.get("render_option", "0")
                    )
                    for media in files
                ]

                for future in as_completed(futures):
                    result = future.result()
                    results.append(result)
                    completed += 1

                    if result.get("stopped"):
                        continue  # không cập nhật progress khi bị dừng

                    progress = int(completed * 100 / total)
                    self._window.evaluate_js(
                        f"updateCropProgress({progress}, {completed}, {total});"
                    )

            return {"success": True, "results": results}
        #CROP ONE          
    def _export_audio_one(self, media, output_dir, option):
        try:
            result = video_utils.export_audio(
                option=option,
                input_path=media["path"],
                output_path=output_dir,
            )

            if result.get("stopped"):
                # Bị dừng chủ động -> không hiện thông báo gì cả
                self._window.evaluate_js(
                    f'updateMediaStatus({json.dumps(media["path"])}, "Đã dừng. Chờ xử lý", "");'
                )
                return result

            if result["success"]:
                self._window.evaluate_js(
                    f'updateMediaStatusExportAudio({json.dumps(media["path"])}, "Xuất audio hoàn tất", "success", {json.dumps(result["output"])});'
                )
            else:
                short_error = video_utils.extract_ffmpeg_error(result["message"])
                self._window.evaluate_js(
                    f'updateMediaStatus({json.dumps(media["path"])}, {json.dumps(short_error)}, "error");'
                )

            return result

        except Exception as ex:
            # Không show lỗi nếu đang trong quá trình dừng
            if video_utils.is_stopping():
                return {"success": False, "message": str(ex), "stopped": True}

            self._window.evaluate_js(
                f'updateMediaStatus({json.dumps(media["path"])}, {json.dumps(str(ex))}, "error");'
            )
            return {"success": False, "message": str(ex)}
    #STOP CROP            
    # def stop_audio_batch(self):
    #     """Gọi từ JS khi người dùng bấm nút Stop."""
    #     video_utils.stop_all_jobs()
    #     return True    


    # TAO VIDEO
    def generate_image_to_video_batch(self, config):
            video_utils.reset_stop_flag()   # cho phép chạy batch mới sau khi đã stop trước đó
            out_dir_ = None
            is_creat_out_dir = None
            if os.path.exists(output_dir_path):
                with open(output_dir_path, "r", encoding="utf-8") as f:
                    configFoder = json.load(f)
                out_dir_ = configFoder.get("video_from_image")
                is_creat_out_dir = configFoder.get("auto_sub_folder", False)
            files = config.get("files", [])
            if not files:
                return {"success": False, "message": "Không có video."}

            threads = self._batch_thread_count(config, 1)

            results = []
            output_dir = Path(out_dir_) if out_dir_ else OUTPUT_DIR
            if is_creat_out_dir:
                sub_folder_name = datetime.now().strftime("%Y%m%d_%H%M%S")
                output_dir = output_dir / sub_folder_name

            output_dir.mkdir(parents=True, exist_ok=True) 
            total = len(files)
            completed = 0
            with ThreadPoolExecutor(max_workers=threads) as executor:
                futures = [
                    executor.submit(
                        self._image_to_video_one, media, output_dir,
                        config.get("render_option", "0"),
                        config.get("width","1080"),
                        config.get("height","1920"),
                        config.get("time_",3),
                        config.get("panhand",False),
                        config.get("hold_seconds",1)
                    )
                    for media in files
                ]

                for future in as_completed(futures):
                    result = future.result()
                    results.append(result)
                    completed += 1

                    if result.get("stopped"):
                        continue  # không cập nhật progress khi bị dừng

                    progress = int(completed * 100 / total)
                    self._window.evaluate_js(
                        f"updateCropProgress({progress}, {completed}, {total});"
                    )

            return {"success": True, "results": results}
        #CROP ONE          
    def _image_to_video_one(self, media, output_dir, option,width,height,time,pandhand,hold_seconds):
        try:
            result = video_utils.image_to_video(
                __windown=self._window,
                option=option,
                width=width,
                height=height,
                input_path=media["path"],
                output_path=output_dir,
                time= time,
                pandhand=pandhand,
                hold_seconds=hold_seconds
            )

            if result.get("stopped"):
                # Bị dừng chủ động -> không hiện thông báo gì cả
                self._window.evaluate_js(
                    f'updateMediaStatus({json.dumps(media["path"])}, "Đã dừng. Chờ xử lý", "");'
                )
                return result

            if result["success"]:
                self._window.evaluate_js(
                    f'updateMediaStatusRender({json.dumps(media["path"])}, "Tạo video thành công", "success", {json.dumps(result["output"])});'
                )
            else:
                short_error = video_utils.extract_ffmpeg_error(result["message"])
                self._window.evaluate_js(
                    f'updateMediaStatusRender({json.dumps(media["path"])}, {json.dumps(short_error)}, "error", null);'
                )

            return result

        except Exception as ex:
            # Không show lỗi nếu đang trong quá trình dừng
            if video_utils.is_stopping():
                return {"success": False, "message": str(ex), "stopped": True}

            self._window.evaluate_js(
                f'updateMediaStatus({json.dumps(media["path"])}, {json.dumps(str(ex))}, "error");'
            )
            return {"success": False, "message": str(ex)}
    
    #TRIM VIDEO 
    def generate_trim_video_batch(self, config):
            video_utils.reset_stop_flag()   # cho phép chạy batch mới sau khi đã stop trước đó
            out_dir_ = None
            is_creat_out_dir = None
            if os.path.exists(output_dir_path):
                with open(output_dir_path, "r", encoding="utf-8") as f:
                    configFoder = json.load(f)
                out_dir_ = configFoder.get("trim_video")
                is_creat_out_dir = configFoder.get("auto_sub_folder", False)
            files = config.get("files", [])
            if not files:
                return {"success": False, "message": "Không có video."}

            threads = self._batch_thread_count(config, 1)

            results = []
            output_dir = Path(out_dir_) if out_dir_ else OUTPUT_DIR
            if is_creat_out_dir:
                sub_folder_name = datetime.now().strftime("%Y%m%d_%H%M%S")
                output_dir = output_dir / sub_folder_name

            output_dir.mkdir(parents=True, exist_ok=True)    
            total = len(files)
            completed = 0
            with ThreadPoolExecutor(max_workers=threads) as executor:
                futures = [
                    executor.submit(
                        self._trim_video_one, media, output_dir,
                        config.get("render_option", "0"),
                        1,
                        media.get("trim") if media.get("trim") is not None else config.get("trim", []),
                    )
                    for media in files
                ]

                for future in as_completed(futures):
                    result = future.result()
                    results.append(result)
                    completed += 1

                    if result.get("stopped"):
                        continue  # không cập nhật progress khi bị dừng

                    progress = int(completed * 100 / total)
                    self._window.evaluate_js(
                        f"updateCropProgress({progress}, {completed}, {total});"
                    )

            return {"success": True, "results": results}
    def _trim_video_one(self, media, output_dir, option,threads,trim):
        try:
            segments = self.generate_segments(
                media.get("path",""),
                output_dir,
                "trim",
                trim
            )
            # print(segments)
            result = video_utils.trim_video_(
                __windown=self._window,
                option=option,
                threads=threads,
                input_media=media.get("path",""),
                segments=segments
            )

            if result.get("stopped"):
                # Bị dừng chủ động -> không hiện thông báo gì cả
                self._window.evaluate_js(
                    f'updateMediaStatus({json.dumps(media["path"])}, "Đã dừng. Chờ xử lý", "");'
                )
                return result

            if result["success"]:
                self._window.evaluate_js(
                    f'updateMediaStatusExport({json.dumps(media["path"])}, "Trim video thành công", "success", {json.dumps(str(output_dir))});'
                )
            else:
                short_error = video_utils.extract_ffmpeg_error(result["message"])
                self._window.evaluate_js(
                    f'updateMediaStatus({json.dumps(media["path"])}, {json.dumps(short_error)}, "error");'
                )

            return result

        except Exception as ex:
            # Không show lỗi nếu đang trong quá trình dừng
            if video_utils.is_stopping():
                return {"success": False, "message": str(ex), "stopped": True}

            self._window.evaluate_js(
                f'updateMediaStatus({json.dumps(media["path"])}, {json.dumps(str(ex))}, "error");'
            )
            return {"success": False, "message": str(ex)}
    def generate_segments(self,input_path, output_directory, output_prefix,trim):
        segments = []
        original_name =  Path(input_path);

        vid_dur = video_utils.get_media_duration_seconds(input_path) or 0.0
        trim = sorted(trim or [], key=lambda x: (x.get("start", 0), x.get("end", 0)))
        for i, box in enumerate(trim):
            start = float(box.get("start", 0) or 0)
            end = video_utils._resolve_timed_end(box, vid_dur)
            duration = end - start

            if duration <= 0:
                continue

            output = Path(output_directory) / f"{original_name.stem}_{output_prefix}_{i+1}.mp4"

            segments.append({
                "start": start,
                "duration": duration,
                "output": str(output)
            })

        return segments

    def _batch_thread_count(self, config, default=1):
        raw = (config or {}).get("threads")
        if raw is None:
            raw = (config or {}).get("thread", default)
        try:
            n = int(raw)
        except (TypeError, ValueError):
            n = default
        return max(1, n)

    def _duration_for_render(self, raw, path):
        text = str(raw or "").strip()
        parts = text.split(":")
        if len(parts) == 3:
            try:
                nums = [int(float(p)) for p in parts]
                return f"{nums[0]}:{nums[1]:02d}:{nums[2]:02d}"
            except (TypeError, ValueError):
                pass
        seconds = video_utils.get_media_duration_seconds(path or "")
        total = max(1, int(round(seconds or 0)))
        h, rem = divmod(total, 3600)
        m, s = divmod(rem, 60)
        return f"{h}:{m:02d}:{s:02d}"
    
    #RENDER 
    def generate_render_batch(self, config):
        video_utils.reset_stop_flag()   # cho phép chạy batch mới sau khi đã stop trước đó
        out_dir_ = None
        is_creat_out_dir =None
        if os.path.exists(output_dir_path):
            with open(output_dir_path, "r", encoding="utf-8") as f:
                configFoder = json.load(f)
            out_dir_ = configFoder.get("render_video")
            is_creat_out_dir = configFoder.get("auto_sub_folder",False)
        files = config.get("files", [])
        if not files:
            return {"success": False, "message": "Không có video."}

        threads = self._batch_thread_count(config, 1)

        self._publish_pool = ThreadPoolExecutor(max_workers=2)
        self._publish_futures = []
        self._publish_lock = threading.Lock()
        self._publish_seen = set()
        results = []
        beside = bool(config.get("output_beside_source"))
        output_dir = Path(out_dir_) if out_dir_ else OUTPUT_DIR
        if not beside and is_creat_out_dir:
            sub_folder_name = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_dir = output_dir / sub_folder_name

        if not beside:
            output_dir.mkdir(parents=True, exist_ok=True)
        contents = config.get("contents", [])
        content_picker = video_utils.ContentPicker(contents)
        total = len(files)
        completed = 0
        jobs = []
        for media in files:
            out = output_dir
            if beside:
                src = Path(str((media or {}).get("path") or ""))
                parent = src.parent if str(src.parent) not in ("", ".") else output_dir
                out = parent / "rendeFinal"
                out.mkdir(parents=True, exist_ok=True)
            jobs.append((media, out))
        try:
            with ThreadPoolExecutor(max_workers=threads) as executor:
                futures = [
                    executor.submit(
                        self._render_video_one, media, out,
                        config,config.get("render_option", "0"),
                        content_picker
                    )
                    for media, out in jobs
                ]

                for future in as_completed(futures):
                    result = future.result()
                    results.append(result)
                    completed += 1

                    if result.get("stopped"):
                        continue  # không cập nhật progress khi bị dừng

                    if beside:
                        if result.get("success"):
                            self.on_download_log("✅ Render xong: " + str(result.get("output") or ""))
                        else:
                            self.on_download_log("❌ Render lỗi: " + str(result.get("message") or "không rõ"))

                    progress = int(completed * 100 / total)
                    self._window.evaluate_js(
                        f"updateCropProgress({progress}, {completed}, {total});"
                    )
        finally:
            publish_futures = list(getattr(self, "_publish_futures", []) or [])
            for fut in publish_futures:
                try:
                    fut.result()
                except Exception as exc:
                    self.on_download_log("❌ Upload: " + str(exc))
            pool = getattr(self, "_publish_pool", None)
            self._publish_pool = None
            self._publish_futures = []
            self._publish_seen = set()
            if pool is not None:
                pool.shutdown(wait=False)

        return self._render_batch_result(results)

    def _render_batch_result(self, results):
        rows = [item for item in (results or []) if isinstance(item, dict)]
        done = sum(1 for item in rows if item.get("success"))
        stopped = sum(1 for item in rows if item.get("stopped") and not item.get("success"))
        failed = len(rows) - done - stopped
        if rows and stopped == len(rows):
            return {"success": False, "stopped": True, "results": rows, "message": "Đã dừng render."}
        if done == 0:
            return {"success": False, "results": rows, "message": "Render lỗi. Không có video nào xong."}
        if failed or stopped:
            return {
                "success": False,
                "results": rows,
                "message": "Render xong {0}/{1} video.".format(done, len(rows)),
            }
        return {"success": True, "results": rows, "message": "Render xong {0}/{1} video.".format(done, len(rows))}

    def _drive_sheet_on(self, config):
        if (config or {}).get("postToFacebook"):
            return True
        try:
            return bool(data_queue.load(APP_DIR).get("enabled"))
        except Exception:
            return False

    def _queue_rendered_publish(self, output_path, media, config):
        path = str(output_path or "").strip()
        if not path:
            return
        pool = getattr(self, "_publish_pool", None)
        lock = getattr(self, "_publish_lock", None)
        if pool is None or lock is None:
            self._publish_rendered_file(path, media, config)
            return
        with lock:
            if path in self._publish_seen:
                return
            self._publish_seen.add(path)
            self._publish_futures.append(
                pool.submit(self._publish_rendered_file, path, dict(media or {}), dict(config or {}))
            )
        if self._drive_sheet_on(config):
            self.on_download_log("Đang đưa lên Drive: " + Path(path).name)

    def _publish_rendered_file(self, output_path, media, config):
        want_tt = (config or {}).get("postToTikTok")
        want_fb = (config or {}).get("postToFacebook")
        notes = []
        media_path = (media or {}).get("path") or ""
        out_name = Path(output_path or "").name
        try:
            dest = workflow.copy_to_ready(
                output_path,
                APP_DIR,
                enabled=True if want_tt else False if want_tt is False else None,
            )
            if want_tt:
                notes.append("TikTok" if dest else "TikTok (chưa có thư mục Ready)")
        except Exception as exc:
            if want_tt:
                notes.append("TikTok lỗi: " + str(exc))
        try:
            def _fb_ui(kind, pct=None):
                if kind == "drive":
                    label = "Đang upload Drive: " + out_name
                    if pct is not None:
                        label = f"{label}  {int(pct)}%"
                    bar = 0 if pct is None else int(pct)
                else:
                    label = "Đang ghi Google Sheet…"
                    bar = 100
                self._window.evaluate_js(
                    f"updateRenderProgress({json.dumps(media_path)}, {json.dumps(str(bar))}, {json.dumps(label)});"
                )

            q = fb_queue.enqueue_output(
                output_path,
                APP_DIR,
                enabled=True if want_fb else False if want_fb is False else None,
                on_progress=(lambda pct: _fb_ui("drive", pct)) if want_fb else None,
                on_stage=(lambda kind: _fb_ui(kind)) if want_fb else None,
            )
            if want_fb:
                if q.get("ok"):
                    notes.append("Facebook")
                    self.on_download_log("Đã ghi Facebook Sheet: " + out_name)
                elif q.get("skipped"):
                    notes.append("Facebook (bỏ qua)")
                else:
                    notes.append("Facebook: " + str(q.get("error") or "lỗi"))
                    self.on_download_log("❌ Facebook: " + out_name + " — " + str(q.get("error") or "lỗi"))
        except Exception as qexc:
            if want_fb:
                notes.append("Facebook: " + str(qexc))
                self.on_download_log("❌ Facebook: " + out_name + " — " + str(qexc))
        try:
            def _data_ui(kind, pct=None):
                if kind == "drive":
                    label = "TikTok · upload Drive: " + out_name
                    if pct is not None:
                        label = f"{label}  {int(pct)}%"
                    bar = 0 if pct is None else int(pct)
                else:
                    label = "TikTok · đang ghi Google Sheet…"
                    bar = 100
                self._window.evaluate_js(
                    f"updateRenderProgress({json.dumps(media_path)}, {json.dumps(str(bar))}, {json.dumps(label)});"
                )

            dq = data_queue.enqueue_output(
                output_path,
                APP_DIR,
                source_path=media_path,
                on_progress=lambda pct: _data_ui("drive", pct),
                on_stage=lambda kind: _data_ui(kind),
            )
            if dq.get("ok"):
                notes.append("TikTok Sheet")
                self.on_download_log("Đã ghi TikTok Sheet: " + out_name)
            elif not dq.get("skipped"):
                notes.append("TikTok Sheet: " + str(dq.get("error") or "lỗi"))
                self.on_download_log("❌ TikTok Sheet: " + out_name + " — " + str(dq.get("error") or "lỗi"))
        except Exception as dexc:
            notes.append("TikTok Sheet: " + str(dexc))
            self.on_download_log("❌ TikTok Sheet: " + out_name + " — " + str(dexc))
        if notes and media_path:
            msg = out_name + " · " + " · ".join(notes)
            self._window.evaluate_js(
                f'updateMediaStatusRender({json.dumps(media_path)}, {json.dumps(msg)}, "success", {json.dumps(output_path)});'
            )

    def _render_video_one(self, media, output_dir, config, option,content_picker):
        crop_tmp_dir = None
        try:

            media = dict(media or {})
            source_path = media.get("path")
            media["duration"] = self._duration_for_render(media.get("duration"), source_path)
            need_effect = False
            if config.get("use_highlight"):
                source_name = Path(str(source_path)).name
                self.on_download_log("Đang lấy đoạn hay: " + source_name)

                def _on_part(path, _media=media, _config=config):
                    self._queue_rendered_publish(path, _media, _config)

                result = video_utils.render_highlight_clip(
                    source_path,
                    str(output_dir),
                    source_url=str(media.get("source_url") or ""),
                    seconds=config.get("highlight_seconds") or 60,
                    score=config.get("highlight_score") or 0.5,
                    track_key=str(source_path or ""),
                    on_log=self.on_download_log,
                    on_progress=self.on_highlight_progress,
                    use_volume=bool(config.get("use_highlight_volume")),
                    use_two_screen=bool(config.get("use_two_screen")),
                    on_part=_on_part,
                )
                if result.get("success") and result.get("message"):
                    self.on_download_log(str(result.get("message")))
            else:
                render_input = source_path
                need_effect = (
                    config.get("crop_segments")
                    or config.get("use_color")
                    or config.get("use_volume")
                )
            if need_effect:
                crop_tmp_dir = Path(output_dir) / "_crop_tmp"
                crop_tmp_dir.mkdir(parents=True, exist_ok=True)
                source_name = Path(str(source_path)).name
                use_crop = bool(config.get("use_crop"))
                use_random_cut = bool(config.get("use_random_cut"))
                pipeline_kwargs = {
                    "use_crop": use_crop,
                    "use_random_cut": use_random_cut,
                    "use_color": bool(config.get("use_color")),
                    "use_volume": bool(config.get("use_volume")),
                    "crop_mode": "random" if use_random_cut else "center",
                }
                if use_crop:
                    pipeline_kwargs["target_w"] = int(config.get("width") or 1080)
                    pipeline_kwargs["target_h"] = int(config.get("height") or 1920)
                if not use_random_cut:
                    full = video_utils.get_media_duration_seconds(source_path) or 1
                    pipeline_kwargs["min_duration"] = full
                    pipeline_kwargs["max_duration"] = full
                labels = []
                if use_crop:
                    labels.append("Crop 9:16")
                if use_random_cut:
                    labels.append("cắt đoạn")
                if pipeline_kwargs["use_color"]:
                    labels.append("màu")
                if pipeline_kwargs["use_volume"]:
                    labels.append("âm lượng")
                self.on_download_log(
                    "Đang xử lý " + " · ".join(labels) + ": " + source_name
                )
                piped = video_utils.process_video_pipeline_wf(
                    option,
                    source_path,
                    str(crop_tmp_dir),
                    **pipeline_kwargs,
                )
                if not piped.get("success"):
                    message = str(piped.get("message") or "Xử lý lỗi")
                    self.on_download_log("❌ " + message)
                    self._window.evaluate_js(
                        f'updateMediaStatusRender({json.dumps(source_path)}, {json.dumps(message)}, "error", null);'
                    )
                    return piped
                staged = Path(piped.get("output") or "")
                named = crop_tmp_dir / source_name
                if staged.is_file() and staged.resolve() != named.resolve():
                    if named.exists():
                        named.unlink()
                    staged.replace(named)
                render_input = str(named if named.is_file() else staged)
                media["duration"] = self._duration_for_render("", render_input)
            if not config.get("use_highlight"):
                result = video_utils.render_video(
                __windown=self._window,
                option=option,
                width=config.get("width",1080),
                height=config.get("height",1920),
                duration=media["duration"],
                input_path=render_input,
                output_path=output_dir,
                output_suffix=config.get("output_suffix") or "",
                files=media.get("files"),
                images= media.get("image") if "image" in media else config.get("image", []),
                hooks=media.get("hook") if "hook" in media else config.get("hook", []),
                texts=media.get("text") if "text" in media else config.get("text", []),
                subs=media.get("sub") if "sub" in media else config.get("sub", []),
                blurs=media.get("blur") if "blur" in media else config.get("blur", []),
                contents=config.get("contents",[]),
                AddOverlay=config.get("AddOverlay",False),
                AddAudio=config.get("AddAudio",False),
                RenderRenderAutoTrim=config.get("RenderRenderAutoTrim",False),
                AddFillter= config.get("AddFillter",False),
                RenameVideo=config.get("RenameVideo",False),
                audioConfig=config.get("audioConfig",{}),
                scale=config.get("scale"),
                content_picker=content_picker,
                preview_start=config.get("preview_start"),
                preview_duration=config.get("preview_duration"),
                crop_fill=bool(config.get("crop_fill")),
                use_two_screen=bool(config.get("use_two_screen")),
            )

            if result.get("stopped"):
                # Bị dừng chủ động -> không hiện thông báo gì cả
                self._window.evaluate_js(
                    f'updateMediaStatus({json.dumps(media["path"])}, "Đã dừng. Chờ xử lý", "");'
                )
                return result

            if result["success"]:
                self._count_rendered_video(media)
                outputs = []
                if result.get("output"):
                    outputs.append(result.get("output"))
                for extra in (result.get("outputs") or [])[1:]:
                    outputs.append(extra)
                for path in outputs:
                    self._queue_rendered_publish(path, media, config)
                msg = "Render xong · đang upload" if self._drive_sheet_on(config) else "Render đã hoàn thành"
                self._window.evaluate_js(
                    f'updateMediaStatusRender({json.dumps(media["path"])}, {json.dumps(msg)}, "success", {json.dumps(result["output"])});'
                )
            else:
                short_error = video_utils.extract_ffmpeg_error(result["message"])
                self._window.evaluate_js(
                    f'updateMediaStatusRender({json.dumps(media["path"])}, {json.dumps(short_error)}, "error", null);'
                )

            return result

        except Exception as ex:
            # Không show lỗi nếu đang trong quá trình dừng
            if video_utils.is_stopping():
                return {"success": False, "message": str(ex), "stopped": True}

            self._window.evaluate_js(
                f'updateMediaStatus({json.dumps(media["path"])}, {json.dumps(str(ex))}, "error");'
            )
            return {"success": False, "message": "Lỗi. Có thể media là ảnh "}
        finally:
            if crop_tmp_dir is not None:
                shutil.rmtree(crop_tmp_dir, ignore_errors=True)

    def get_workflow(self):
        data = workflow.load(APP_DIR)
        data["stats"] = workflow.stats(APP_DIR)
        return data

    def save_workflow(self, data):
        result = workflow.save(APP_DIR, data or {})
        if result.get("ok"):
            result["stats"] = workflow.stats(APP_DIR)
        return result

    def pick_workflow_file(self, create=False):
        try:
            if create:
                result = self._window.create_file_dialog(
                    webview.SAVE_DIALOG,
                    save_filename="workflow.json",
                    file_types=("JSON Files (*.json)",),
                )
            else:
                result = self._window.create_file_dialog(
                    webview.OPEN_DIALOG,
                    file_types=("JSON Files (*.json)", "All files (*.*)"),
                )
            if not result:
                return ""
            path = result if isinstance(result, str) else result[0]
            if not path:
                return ""
            workflow.set_shared_file(APP_DIR, path)
            return path
        except Exception as e:
            return {"error": str(e)}

    def get_fb_queue(self):
        data = fb_queue.load(APP_DIR)
        try:
            data["stats"] = fb_queue.queue_stats(APP_DIR)
        except Exception:
            data["stats"] = {}
        return data

    def save_fb_queue(self, data):
        result = fb_queue.save(APP_DIR, data or {})
        return result

    def pick_oauth_json(self):
        try:
            result = self._window.create_file_dialog(
                webview.OPEN_DIALOG,
                file_types=("JSON Files (*.json)", "All files (*.*)"),
            )
            if not result:
                return ""
            return result if isinstance(result, str) else result[0]
        except Exception as e:
            return {"error": str(e)}

    def account_fb_queue(self):
        try:
            return fb_queue.account_status(APP_DIR)
        except Exception:
            return {"ok": False}

    def connect_fb_queue(self):
        try:
            return fb_queue.connect(APP_DIR)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def init_fb_sheet(self):
        try:
            return fb_queue.init_sheet(APP_DIR)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def refresh_fb_queue_stats(self):
        try:
            return {"ok": True, "stats": fb_queue.queue_stats(APP_DIR)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_data_queue(self):
        data = data_queue.load(APP_DIR)
        try:
            data["stats"] = data_queue.queue_stats(APP_DIR)
        except Exception:
            data["stats"] = {
                "pending": 0,
                "claimed": 0,
                "posting": 0,
                "posted": 0,
                "failed": 0,
            }
        return data

    def save_data_queue(self, data):
        return data_queue.save(APP_DIR, data or {})

    def account_data_queue(self):
        try:
            return data_queue.account_status(APP_DIR)
        except Exception:
            return {"ok": False}

    def connect_shared_oauth(self):
        try:
            cfg = data_queue.load(APP_DIR)
            oauth = Path(str(cfg.get("oauth_json") or "").strip())
            if not oauth.is_file():
                cfg = fb_queue.load(APP_DIR)
                oauth = Path(str(cfg.get("oauth_json") or "").strip())
            if not oauth.is_file():
                return {"ok": False, "error": "Chưa chọn file OAuth JSON."}
            sheet_queue.discard_token(oauth)
            sheet_queue.credentials(oauth)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def connect_data_queue(self):
        try:
            return data_queue.connect(APP_DIR)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def init_data_sheet(self):
        try:
            return data_queue.init_sheet(APP_DIR)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def refresh_data_queue_stats(self):
        try:
            return {"ok": True, "stats": data_queue.queue_stats(APP_DIR)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def generate_fast_preview(self, config):
        video_utils.reset_stop_flag()
        files = config.get("files") or []
        if not files:
            return {"success": False, "message": "Không có video."}
        media = files[0]
        out_dir_ = None
        if os.path.exists(output_dir_path):
            with open(output_dir_path, "r", encoding="utf-8") as f:
                configFoder = json.load(f)
            out_dir_ = configFoder.get("render_video")
        output_dir = Path(out_dir_) if out_dir_ else OUTPUT_DIR
        output_dir.mkdir(parents=True, exist_ok=True)
        config = dict(config or {})
        config["RenameVideo"] = False
        config["RenderRenderAutoTrim"] = False
        result = video_utils.render_video(
            __windown=self._window,
            option=config.get("render_option", "0"),
            width=config.get("width", 1080),
            height=config.get("height", 1920),
            duration=media.get("duration"),
            input_path=media["path"],
            output_path=output_dir,
            files=media.get("files") or [],
            images=config.get("image", []),
            hooks=config.get("hook", []),
            texts=config.get("text", []),
            subs=config.get("sub", []),
            blurs=config.get("blur", []),
            contents=config.get("contents", []),
            AddOverlay=config.get("AddOverlay", True),
            AddAudio=config.get("AddAudio", True),
            RenderRenderAutoTrim=False,
            AddFillter=config.get("AddFillter", False),
            RenameVideo=False,
            audioConfig=config.get("audioConfig") or {},
            scale=config.get("scale") or {},
            preview_start=config.get("preview_start"),
            preview_duration=config.get("preview_duration") or 5,
            use_two_screen=bool(config.get("use_two_screen")),
        )
        if result.get("success"):
            self._window.evaluate_js(
                f'updateMediaStatusRender({json.dumps(media["path"])}, "Fast Preview xong", "success", {json.dumps(result["output"])});'
            )
        elif result.get("stopped"):
            self._window.evaluate_js(
                f'updateMediaStatus({json.dumps(media["path"])}, "Đã dừng. Chờ xử lý", "");'
            )
        else:
            msg = video_utils.extract_ffmpeg_error(result.get("message") or "")
            self._window.evaluate_js(
                f'updateMediaStatus({json.dumps(media["path"])}, {json.dumps(msg or "Fast Preview lỗi")}, "error");'
            )
        return result

    def write_srt_file(self, path, segments):
        try:
            from translation.srt_io import to_srt
            out = Path(path)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(to_srt(segments or []), encoding="utf-8")
            return {"ok": True, "path": str(out)}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    #END RENDER
    
    #GHEP VIDEO
    def generate_merge_video_batch(self, config):
        video_utils.reset_stop_flag()
        out_dir_ = None
        is_creat_out_dir = None
        if os.path.exists(output_dir_path):
            with open(output_dir_path, "r", encoding="utf-8") as f:
                configFoder = json.load(f)
            out_dir_ = configFoder.get("merge_video")
            is_creat_out_dir = configFoder.get("auto_sub_folder", False)

        plans = config.get("plans", [])
        if not plans:
            return {"success": False, "message": "Không có video."}

        threads = self._batch_thread_count(config, 1)
        results = []
        output_dir = Path(out_dir_) if out_dir_ else OUTPUT_DIR
        if is_creat_out_dir:
            sub_folder_name = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_dir = output_dir / sub_folder_name

        output_dir.mkdir(parents=True, exist_ok=True)
        total = len(plans)
        completed = 0

        with ThreadPoolExecutor(max_workers=threads) as executor:
            futures = [
                executor.submit(
                    self._merge_video_one, plan, output_dir,
                    config.get("render_option", "0"),config  # <-- truyền index i vào
                )
                for plan in plans      
            ]

            for future in as_completed(futures):
                result = future.result()
                results.append(result)
                completed += 1

                if result.get("stopped"):
                    continue

                progress = int(completed * 100 / total)
                self._window.evaluate_js(
                    f"updateCropProgress({progress}, {completed}, {total});"
                )

        return {"success": True, "results": results}
    def _merge_video_one(self, plan, output_dir, option,config):
        name = plan.get("name", "")   # khai báo 1 lần, dùng xuyên suốt cả hàm
        try:
            self._window.evaluate_js(
                    f'updateMediaStatusMerge({json.dumps(name)}, "Đang tiến hành xử lý", "processing", null);'
                )

            result = video_utils.merge_video(
                __windown=self._window,
                option=option,
                input_paths=plan.get("files", []),
                output_path=output_dir,
                output_name=name,
                width=int(config["width"]),
                height=int(config["height"]),
            )

            if result.get("stopped"):
                self._window.evaluate_js(
                    f'updateMediaStatusMerge({json.dumps(name)}, "Đã dừng. Chờ xử lý", "");'
                )
                return result

            if result["success"]:
                self._window.evaluate_js(
                    f'updateMediaStatusMerge({json.dumps(name)}, "Ghép video hoàn tất", "success", {json.dumps(result["output"])});'
                )
            else:
                short_error = video_utils.extract_ffmpeg_error(result["message"])
                self._window.evaluate_js(
                    f'updateMediaStatusMerge({json.dumps(name)}, {json.dumps(short_error)}, "error", null);'
                )

            return result

        except Exception as ex:
            if video_utils.is_stopping():
                return {"success": False, "message": str(ex), "stopped": True}

            self._window.evaluate_js(
                f'updateMediaStatus({json.dumps(name)}, {json.dumps(str(ex))}, "error");'
            )
            return {"success": False, "message": str(ex)}
        # END GHEP VIDEO      
    # ==================================================
    # TẠO PHỤ ĐỀ HÀNG LOẠT (whisper_utils, không socket)
    # ==================================================

    def generate_subtitle_batch(self, config):
        files = config.get("files", [])
        out_dir_sub = None
        if os.path.exists(output_dir_path):
            with open(output_dir_path, "r", encoding="utf-8") as f:
                configFoder = json.load(f)
            out_dir_sub = configFoder.get("subtitle")
        files = config.get("files", [])
        output_dir = Path(out_dir_sub) if out_dir_sub else OUTPUT_DIR
        output_dir.mkdir(parents=True, exist_ok=True)
        if not files:
            return {"success": False, "message": "Không có file audio/video."}
        

        jobs = []
        self._subtitle_job_map = {}  # job_id -> audio_path

        for media in files:
            audio_path = media["path"]
            job_id = str(uuid.uuid4())
            stem = Path(audio_path).stem
            output_path = str(output_dir / f"{stem}.srt")

            jobs.append({"job_id": job_id, "audio": audio_path, "output": output_path})
            self._subtitle_job_map[job_id] = audio_path

        whisper_utils.transcribe_batch(
            jobs,
            language=config.get("language", "auto"),
            vad=False,
            max_workers=self._batch_thread_count(config, 1),
            on_progress=self._on_subtitle_progress,
            on_file_done=self._on_subtitle_done,
            on_file_error=self._on_subtitle_error,
            on_batch_done=self._on_subtitle_batch_done,
        )

        return {"success": True, "total": len(jobs)}

    def _on_subtitle_progress(self, job_id, percent, label=None):
        path = self._subtitle_job_map.get(job_id)
        if path and self._window:
            lbl = json.dumps(label or "Đang xử lý")
            self._window.evaluate_js(
                f'updateRenderProgress({json.dumps(path)}, {int(percent)}, {lbl});'
            )

    def _on_subtitle_done(self, job_id, output_path):
        path = self._subtitle_job_map.get(job_id)
        if path and self._window:
            self._window.evaluate_js(
                f'updateMediaStatusExportSTT({json.dumps(path)}, "Xuất phụ đề hoàn tất", "success", {json.dumps(output_path)});'
            )

    def _on_subtitle_error(self, job_id, message):
        path = self._subtitle_job_map.get(job_id)
        if path and self._window:
            self._window.evaluate_js(
                f'updateMediaStatus({json.dumps(path)}, {json.dumps(message)}, "error");'
            )

    def _on_subtitle_batch_done(self, results):
        if self._window:
            self._window.evaluate_js("onSubtitleBatchDone();")

    def stop_subtitle_batch(self):
        job_ids = list(self._subtitle_job_map.keys())
        whisper_utils.stop_all(job_ids)
        return True

    def generate_ocr_subtitle_batch(self, config):
        files = config.get("files", [])
        out_dir_sub = None
        if os.path.exists(output_dir_path):
            with open(output_dir_path, "r", encoding="utf-8") as f:
                configFoder = json.load(f)
            out_dir_sub = configFoder.get("subtitle")
        output_dir = Path(out_dir_sub) if out_dir_sub else OUTPUT_DIR
        if not files:
            return {"success": False, "message": "Không có file video."}

        import ocr
        jobs = []
        self._ocr_job_map = {}
        for media in files:
            video_path = media["path"]
            job_id = str(uuid.uuid4())
            stem = Path(video_path).stem
            output_path = str(output_dir / f"{stem}_ocr.srt")
            jobs.append({
                "job_id": job_id,
                "video": video_path,
                "output": output_path,
                "regions": media.get("ocr_regions") or media.get("ocrRegions"),
                "translate_engine": media.get("translate_engine") or config.get("translate_engine"),
            })
            self._ocr_job_map[job_id] = video_path

        import json as _json
        regions = config.get("ocr_regions")
        raw_json = config.get("ocr_regions_json")
        if raw_json:
            try:
                regions = _json.loads(raw_json) if isinstance(raw_json, str) else raw_json
            except Exception:
                pass
        ocr.transcribe_batch(
            jobs,
            region=config.get("ocr_region", "bottom"),
            crop_ratio=float(config.get("ocr_crop_ratio", 0.25) or 0.25),
            crop_box=config.get("ocr_box"),
            time_start=config.get("ocr_time_start"),
            time_end=config.get("ocr_time_end"),
            regions=regions,
            fps=config.get("ocr_fps"),
            max_workers=1,
            use_gpu=bool(config.get("ocr_use_gpu")),
            translate_engine=config.get("translate_engine"),
            on_progress=self._on_ocr_progress,
            on_file_done=self._on_ocr_done,
            on_file_error=self._on_ocr_error,
            on_batch_done=self._on_ocr_batch_done,
        )
        return {"success": True, "total": len(jobs)}

    def _on_ocr_progress(self, job_id, percent):
        path = self._ocr_job_map.get(job_id)
        if path and self._window:
            self._window.evaluate_js(
                f'updateRenderProgress({json.dumps(path)}, {percent});'
            )

    def _on_ocr_done(self, job_id, output_path, translated_path="", message="", need_web=False):
        path = self._ocr_job_map.get(job_id)
        if path and self._window:
            self._window.evaluate_js(
                "onOcrSubtitleDone("
                f"{json.dumps(path)}, {json.dumps(output_path)}, "
                f"{json.dumps(translated_path or '')}, {json.dumps(message or '')}, "
                f"{'true' if need_web else 'false'});"
            )

    def _on_ocr_error(self, job_id, message):
        path = self._ocr_job_map.get(job_id)
        if path and self._window:
            self._window.evaluate_js(
                f'updateMediaStatus({json.dumps(path)}, {json.dumps(message)}, "error");'
            )

    def _on_ocr_batch_done(self, results):
        if self._window:
            self._window.evaluate_js("onSubtitleBatchDone();")

    def stop_ocr_subtitle_batch(self):
        import ocr
        job_ids = list(getattr(self, "_ocr_job_map", {}).keys())
        ocr.stop_all(job_ids)
        return True

    def open_folder(self, path):
        try:

            if not path:
                return False

            if not os.path.exists(path):
                return False


            system = platform.system()

            if system == "Windows":
                os.startfile(path)

            elif system == "Darwin": # macOS
                popen_hidden(["open", path])

            else: # Linux
                popen_hidden(["xdg-open", path])


            return True

        except Exception as e:
            return False
    def _templates_dir(self):
        d = Path(BASE_DIR) / "config" / "templates"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def save_timeline_template(self, name, payload):
        try:
            name = (name or "").strip() or "Template"
            tid = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"
            rec = {
                "id": tid,
                "name": name,
                "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "payload": payload or {},
            }
            path = self._templates_dir() / f"{tid}.json"
            path.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
            return {"ok": True, "id": tid, "name": name}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def list_timeline_templates(self):
        items = []
        try:
            for p in sorted(self._templates_dir().glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
                try:
                    rec = json.loads(p.read_text(encoding="utf-8"))
                    payload = rec.get("payload") or {}
                    layers = payload.get("layers") or []
                    items.append({
                        "id": rec.get("id") or p.stem,
                        "name": rec.get("name") or p.stem,
                        "created_at": rec.get("created_at") or "",
                        "layer_count": len(layers),
                    })
                except Exception:
                    continue
        except Exception:
            pass
        return items

    def load_timeline_template(self, template_id):
        try:
            path = self._templates_dir() / f"{str(template_id)}.json"
            if not path.exists():
                return {"ok": False, "error": "Không tìm thấy template"}
            rec = json.loads(path.read_text(encoding="utf-8"))
            return {"ok": True, "template": rec}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def delete_timeline_template(self, template_id):
        try:
            path = self._templates_dir() / f"{str(template_id)}.json"
            if path.exists():
                path.unlink()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def translate_texts(self, texts, src_lang="auto", target_lang="vi", engine=None):
        from translation.service import translate_texts as _translate_texts
        return _translate_texts(
            texts or [],
            src_lang or "auto",
            target_lang or "vi",
            engine,
        )

    def get_translate_settings(self):
        from translation.service import get_translate_settings
        return get_translate_settings()

    def set_translate_engine(self, engine):
        from translation.service import set_translate_engine
        return set_translate_engine(engine)

    def set_gemini_api_key(self, api_key, model=None):
        from translation.service import set_gemini_api_key
        return set_gemini_api_key(api_key, model)

    def ocr_frame_quick(self, video_path, time_sec=0, crop_box=None, src_lang="auto", dst_lang="vi", do_translate=True, use_gpu=False, translate_engine=None):
        import ocr
        if not video_path:
            return {"ok": False, "error": "Chưa có video."}
        return ocr.ocr_still_frame(
            str(video_path),
            time_sec=time_sec,
            crop_box=crop_box,
            src_lang=src_lang or "auto",
            dst_lang=dst_lang or "vi",
            do_translate=bool(do_translate),
            use_gpu=bool(use_gpu),
            translate_engine=translate_engine,
        )

    def translate_files(self, paths, src_lang="auto", target_lang="vi", engine=None):
        from translation.service import translate_file
        results = []
        for p in paths or []:
            try:
                results.append(translate_file(str(p), src_lang or "auto", target_lang or "vi", engine))
            except Exception as e:
                results.append({"ok": False, "error": str(e), "path": str(p)})
        return results

    def save_folder_config(self, config):

        try:

            config_path = os.path.join(
                BASE_DIR,
                "config",
                "folder_config.json"
            )
            with open(
                config_path,
                "w",
                encoding="utf-8"
            ) as f:

                json.dump(
                    config,
                    f,
                    indent=4,
                    ensure_ascii=False
                )


            return True


        except Exception as e:
            return False            
    def get_folder_config(self):

        try:

            path = os.path.join(
                BASE_DIR,
                "config",
                "folder_config.json"
            )

            if not os.path.exists(path):

                return {}


            with open(
                path,
                "r",
                encoding="utf-8"
            ) as f:

                return json.load(f)


        except Exception as e:
            return {}
    def get_clone_config(self):
        try:
            resp = requests.get(
                f"{API_BASE_URL}/voices",
                timeout=TIMEOUT,
            )
            resp.raise_for_status()
            return resp.json()
        except:
            return {}

    def scene_studio_get(self):
        return scene_studio.load_state(APP_DIR)

    def scene_studio_save(self, data):
        try:
            return scene_studio.save_state(APP_DIR, data)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def scene_studio_pick(self, kind):
        try:
            if kind == "video":
                types = ("Video (*.mp4;*.mov;*.mkv;*.webm;*.m4v)",)
            else:
                types = ("Ảnh (*.png;*.jpg;*.jpeg;*.webp)",)
            result = self._window.create_file_dialog(webview.OPEN_DIALOG, file_types=types)
            if not result:
                return None
            path = unicodedata.normalize("NFC", result[0])
            if not Path(path).is_file():
                return {"error": "File không tồn tại."}
            return {"path": path, "name": Path(path).name}
        except Exception as exc:
            return {"error": str(exc)}

    def scene_studio_export(self):
        try:
            return scene_studio.export_ready(APP_DIR)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def flowkit_get(self):
        try:
            return flowkit_bridge.snapshot(APP_DIR)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def flowkit_status(self):
        try:
            return flowkit_bridge.status(APP_DIR)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def flowkit_save(self, data):
        try:
            return flowkit_bridge.save_draft(APP_DIR, data)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def flowkit_pick_agent(self):
        try:
            result = self._window.create_file_dialog(webview.FOLDER_DIALOG)
            if not result:
                return None
            return {"path": result[0]}
        except Exception as exc:
            return {"error": str(exc)}

    def flowkit_start(self):
        try:
            return flowkit_bridge.start_agent(APP_DIR)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def flowkit_sync(self, data):
        try:
            return flowkit_bridge.sync(APP_DIR, data)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def flowkit_enqueue(self, stage):
        try:
            return flowkit_bridge.enqueue(APP_DIR, stage)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def flowkit_regen(self, kind, local_id):
        try:
            return flowkit_bridge.regen(APP_DIR, kind, local_id)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def flowkit_export(self):
        try:
            return flowkit_bridge.export_ready(APP_DIR)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def flowkit_forget(self):
        try:
            return flowkit_bridge.forget_remote(APP_DIR)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def flowkit_remove(self, kind, remote_id):
        try:
            return flowkit_bridge.remove_remote(APP_DIR, kind, remote_id)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def open_url(self, url):
        import webbrowser
        u = str(url or "").strip()
        if not u.startswith("http://") and not u.startswith("https://"):
            return {"ok": False, "error": "URL không hợp lệ."}
        webbrowser.open(u)
        return {"ok": True}

    def open_pip_window(self, video_url):
        try:
            win_width = 360
            win_height = 640

            # Lấy kích thước màn hình để tự canh giữa
            screen = webview.screens[0]
            x = int((screen.width - win_width) / 2)
            y = int((screen.height - win_height) / 2)

            html = f"""
            <html>
            <body style="margin:0;background:#000;overflow:hidden;">
                <video src="{video_url}" autoplay controls
                       style="width:100%;height:100%;object-fit:contain;display:block;"></video>
            </body>
            </html>
            """

            webview.create_window(
                "Mini Preview Video",
                html=html,
                width=win_width,
                height=win_height,
                x=x,
                y=y,
                on_top=True,
                resizable=True,
            )
        except Exception as e:
            _safe_print("Lỗi mở cửa sổ mini preview:", e)        
    def find_transition_videos(self, config):
        names = config.get("names", [])
        result = video_utils.find_transition_videos(TRANSITION_DIR, names)
        return {"success": True, "result": result}
def _init_background(window):
    """Chạy sau khi cửa sổ loading đã hiện, load model, rồi chuyển sang giao diện chính."""
    try:
        whisper_utils.init_models(num_models=2)
    except Exception as e:
        traceback.print_exc()
        window.evaluate_js(
            f'document.getElementById("msg").innerText = {json.dumps("Lỗi khởi tạo: " + str(e))};'
        )
        return

    # # load xong -> chuyển sang giao diện chính
    window.maximize() 
    window.load_url(str(RESOURCE_DIR / "web" / "login.html"))

def main():
    api = Api()

    WINDOW_WIDTH = 600
    WINDOW_HEIGHT = 300

    # Tính tọa độ để canh giữa màn hình
    try:
        screen = webview.screens[0]
        x = (screen.width - WINDOW_WIDTH) // 2
        y = (screen.height - WINDOW_HEIGHT) // 2
    except Exception:
        # fallback nếu không lấy được thông tin màn hình
        x, y = None, None

    window = webview.create_window(
        "Render - Sub Studio v2.88",
        str(RESOURCE_DIR / "web" / "loading.html"),
        js_api=api,
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
        x=x,
        y=y,
        min_size=(300, 300),
    )

    api.set_window(window)
    download_manager.on_log = api.on_download_log
    download_manager.on_progress = api.on_download_progress
    download_manager.on_file_progress = api.on_download_file_progress
    download_manager.on_done = api.on_download_done
    download_manager.on_saved = api._on_download_saved

    DEBUG_MODE = not getattr(sys, "frozen", False)
    window.events.shown += lambda: set_window_icon(window)
    window.events.closing += api.on_window_closing
    webview.start(_init_background, window, debug=DEBUG_MODE)
if __name__ == "__main__":
    main()