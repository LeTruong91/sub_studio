
import sys


if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
import os
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
import shutil
import audio_utils
import vera_tts
import subtitle_utils
import account 
import whisper_utils
import requests
import time
# MEDIA_FOLDER = r"D:\Media"
# THUMB_FOLDER = r"D:\MediaThumb"


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
FONT_DIR = os.path.join(RESOURCE_DIR, "web", "fonts") 
ICON_PATH = RESOURCE_DIR  / "icon.ico"
API_BASE_URL = "http://127.0.0.1:8282/v1"  # server chuẩn VieNeu (apps/openai_speech.py)
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
try:
    SAMPLE_RATE = vera_tts.SAMPLE_RATE
except Exception:
    SAMPLE_RATE = 24000

output_dir_path = os.path.join( BASE_DIR, "config", "folder_config.json" )

def _safe_print(*args, **kwargs):
    try:
        print(*args, **kwargs)
    except UnicodeEncodeError:
        pass
VOICE_SERVER_PORT = 8282
VOICE_SERVER_URL = f"http://127.0.0.1:{VOICE_SERVER_PORT}"
_VOICE_SERVER_PROC = None   # tien trinh server do app mo (None neu server da chay san)
_VOICE_SERVER_LOG = None    # file log server (giu tham chieu de khong bi dong som)
_VOICE_SERVER_DIR = None    # thu muc server da tim thay (cache)


def _find_voice_server_dir():
    """Tim thu muc server VieNeu-TTS: noi co apps/openai_speech.py.
    Uu tien thu muc VieNeu-TTS canh file exe (sau nay build)."""
    global _VOICE_SERVER_DIR
    if _VOICE_SERVER_DIR:
        return _VOICE_SERVER_DIR
    candidates = [
        APP_DIR / "VieNeu-TTS",
        APP_DIR / "VoiceStudio" / "VieNeu-TTS",
        APP_DIR.parent / "VieNeu-TTS",
        APP_DIR.parent / "VoiceStudio" / "VieNeu-TTS",
    ]
    for root in candidates:
        if (root / "apps" / "openai_speech.py").is_file():
            _VOICE_SERVER_DIR = root
            return root
    for base in (APP_DIR, APP_DIR.parent):
        try:
            for sub in sorted(base.iterdir()):
                if not sub.is_dir():
                    continue
                if (sub / "apps" / "openai_speech.py").is_file():
                    _VOICE_SERVER_DIR = sub
                    return sub
                for sub2 in sorted(sub.iterdir()):
                    if sub2.is_dir() and (sub2 / "apps" / "openai_speech.py").is_file():
                        _VOICE_SERVER_DIR = sub2
                        return sub2
        except Exception:
            continue
    return None


def _find_python():
    """Tim python de chay server: python tren PATH, roi py launcher, roi python cua app (dev)."""
    for name in ("python", "py"):
        path = shutil.which(name)
        if path:
            return path
    if not getattr(sys, "frozen", False):
        return sys.executable
    return None


def _voice_server_alive():
    """Server da nghe o 8282 chua (GET /health, timeout ngan)."""
    try:
        resp = requests.get(f"{VOICE_SERVER_URL}/health", timeout=2)
        return resp.status_code == 200
    except Exception:
        return False


def _start_voice_server():
    """Mo server neu chua chay. Chi mo tien trinh, khong cho san sang.
    Tra ve dict {ok, already|started|error}."""
    global _VOICE_SERVER_PROC, _VOICE_SERVER_LOG
    if _voice_server_alive():
        return {"ok": True, "already": True}
    server_dir = _find_voice_server_dir()
    if server_dir is None:
        return {"ok": False, "error": "Không tìm thấy thư mục server (cần có apps/openai_speech.py cạnh file exe)."}
    py = _find_python()
    if not py:
        return {"ok": False, "error": "Không tìm thấy Python trên máy để chạy server."}
    try:
        TMP_DIR.mkdir(parents=True, exist_ok=True)
        log_file = open(TMP_DIR / "server.log", "ab")
        _VOICE_SERVER_LOG = log_file
        env = dict(os.environ)
        env["PORT"] = str(VOICE_SERVER_PORT)
        env["PYTHONUNBUFFERED"] = "1"
        cmd = [py, "-m", "apps.openai_speech"]
        if os.path.basename(py).lower() in ("py.exe", "py"):
            cmd = [py, "-3", "-m", "apps.openai_speech"]
        _VOICE_SERVER_PROC = popen_hidden(
            cmd, cwd=str(server_dir), env=env,
            stdout=log_file, stderr=log_file,
        )
        return {"ok": True, "started": True}
    except Exception as e:
        return {"ok": False, "error": f"Không mở được server: {e}"}


def _wait_voice_server(timeout_s=120):
    """Cho server nghe o 8282, toi da timeout_s giay."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if _voice_server_alive():
            return True
        if _VOICE_SERVER_PROC is not None and _VOICE_SERVER_PROC.poll() is not None:
            return False  # tien trinh do app mo da tat (xem _tmp/server.log)
        time.sleep(1)
    return _voice_server_alive()


def _stop_voice_server():
    """Tat server neu chinh app da mo no (khong tat server do anh mo tay)."""
    global _VOICE_SERVER_PROC
    proc = _VOICE_SERVER_PROC
    _VOICE_SERVER_PROC = None
    if proc is None:
        return
    try:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
    except Exception:
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
            _stop_voice_server()
            return True
        try:
            url = ""
            if self._window and hasattr(self._window, "get_current_url"):
                url = self._window.get_current_url() or ""
            if "loading.html" in str(url):
                _stop_voice_server()
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
    
    # ==================================================
    # CHỌN FILE
    # ==================================================


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
    def read_text_file(self, path):
        """Đọc nội dung file văn bản/phụ đề để sửa trong ô nội dung (kèm chip cảm xúc)."""
        try:
            p = Path(path)
            if not p.is_file():
                return {"ok": False, "error": "Không tìm thấy file."}
            if p.stat().st_size > 2 * 1024 * 1024:
                return {"ok": False, "error": "File quá lớn (>2MB)."}
            text = p.read_text(encoding="utf-8-sig", errors="replace")
            return {"ok": True, "text": text}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    def save_text_file(self, path, text):
        """Ghi lại nội dung đã sửa vào file gốc (ô nội dung + chip cảm xúc)."""
        try:
            p = Path(path)
            if not p.is_file():
                return False
            if len(text or "") > 2 * 1024 * 1024:
                return False
            p.write_text(text or "", encoding="utf-8")
            return True
        except Exception:
            return False
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
    #THEM 

    def _resolve_output_dir(self):
        """Thư mục xuất file wav — cùng logic với worker tạo batch."""
        voice_subtitle = None
        if os.path.exists(output_dir_path):
            try:
                with open(output_dir_path, "r", encoding="utf-8") as f:
                    voice_subtitle = json.load(f).get("voice_subtitle")
            except Exception:
                voice_subtitle = None
        return Path(voice_subtitle) if voice_subtitle else OUTPUT_DIR

    def list_recent_files(self, limit=10):
        """Liệt kê file wav mới nhất trong thư mục xuất (cho mục Bản ghi gần đây)."""
        try:
            output_dir = self._resolve_output_dir()
            if not output_dir.exists():
                return {"output_dir": str(output_dir), "files": []}
            wavs = [p for p in output_dir.glob("*.wav") if p.is_file()]
            wavs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            items = []
            for p in wavs[:max(1, int(limit or 10))]:
                st = p.stat()
                dur = ""
                try:
                    import wave as _wave
                    with _wave.open(str(p), "rb") as w:
                        secs = w.getnframes() / float(w.getframerate() or 1)
                        dur = f"{int(secs // 60)}:{int(secs % 60):02d}"
                except Exception:
                    dur = ""
                size = st.st_size
                size_str = f"{size / 1024:.0f} KB" if size < 1024 * 1024 else f"{size / (1024 * 1024):.1f} MB"
                items.append({
                    "name": p.stem,
                    "path": str(p),
                    "size": size_str,
                    "duration": dur,
                    "time": time.strftime("%H:%M %d-%m", time.localtime(st.st_mtime)),
                })
            return {"output_dir": str(output_dir), "files": items}
        except Exception as e:
            return {"output_dir": "", "files": [], "error": str(e)}

    def _recent_file_in_output(self, path):
        """Kiểm tra file có nằm trong thư mục xuất không (chống xóa/đổi tên nhầm)."""
        try:
            output_dir = self._resolve_output_dir().resolve()
            p = Path(unicodedata.normalize('NFC', path)).resolve()
            return p if (output_dir in p.parents and p.suffix.lower() == ".wav") else None
        except Exception:
            return None

    def delete_recent_file(self, path):
        """Xóa 1 file wav bản ghi (kèm file .srt cùng tên nếu có)."""
        try:
            p = self._recent_file_in_output(path)
            if p is None:
                return False
            p.unlink(missing_ok=True)
            srt = p.with_suffix(".srt")
            if srt.exists():
                srt.unlink()
            return True
        except Exception:
            return False

    def rename_recent_file(self, path, new_name):
        """Đổi tên 1 file wav bản ghi (kèm file .srt cùng tên nếu có)."""
        try:
            p = self._recent_file_in_output(path)
            if p is None:
                return {"ok": False, "error": "Đường dẫn không hợp lệ"}
            stem = unicodedata.normalize('NFC', (new_name or "").strip())
            for ch in '\\/:*?"<>|':
                stem = stem.replace(ch, "")
            stem = stem.strip().strip(".")
            if not stem:
                return {"ok": False, "error": "Tên mới trống"}
            target = p.with_name(stem + ".wav")
            if target.exists() and target != p:
                return {"ok": False, "error": "Đã có file trùng tên"}
            p.rename(target)
            srt = p.with_suffix(".srt")
            if srt.exists():
                srt.rename(target.with_suffix(".srt"))
            return {"ok": True, "path": str(target)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

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
    # END TẠO HÀNG LOẠT SUB (BATCH GENERATION)



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
            text_source = str(config.get("text") or "").strip()
            if text_source:
                TMP_DIR.mkdir(parents=True, exist_ok=True)
                text_path = TMP_DIR / "van_ban.txt"
                text_path.write_text(text_source, encoding="utf-8")
                files = [{"path": str(text_path), "name": "van_ban.txt"}]

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
        enable_clone_save = bool(config.get("enable_clone_save",False))
        nameCloneSave = config.get("nameCloneSave","NameVoice")
        desCLoneSave = config.get("desCLoneSave","Mô Tả Voice")
        genderCloneSave = str(config.get("genderCloneSave") or "").strip()
        language = config.get("language","vi")
        instruct = str(config.get("instruct") or "").strip()
        # ====== SỐ LUỒNG CHO FILE (không còn dùng cho count nữa) ======
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
                # cues/script gốc giống nhau cho mọi version -> load 1 lần
                base_cues = None
                base_script_text = None
                original_ext = Path(original_path).suffix.lower()
                source_stem = unicodedata.normalize('NFC', Path(original_path).stem)
                base_cues = subtitle_utils.load_cues(original_path)
                base_script_text = subtitle_utils.full_script_text(base_cues)

                # Tên file ra: {index} là số phiên bản. Tìm số còn trống để
                # tạo lại cùng tên không đè file cũ (vd tạo tiếp từ text).
                def _stem_for(idx):
                    s = name_pattern.replace("{index}", str(idx).zfill(2)) \
                                    .replace("{voice}", voice) \
                                    .replace("{file}", source_stem)
                    return unicodedata.normalize('NFC', Path(s).stem)

                start_index = 1
                while ((output_dir / f"{_stem_for(start_index)}.wav").exists()
                       or (output_dir / f"{_stem_for(start_index)}.srt").exists()):
                    start_index += 1

                # ====== VÒNG LẶP TUẦN TỰ QUA TỪNG PHIÊN BẢN ======
                for index in range(1, count + 1):
                    if self._gen_stop.is_set():
                        self._emit("status", {
                            "message": f"[{file_index}/{total_files}] Đã dừng: {original_name}",
                            "file_name": original_name,
                        })
                        return {"success": False, "stopped": True, "file_name": original_name}

                    version_no = start_index + index - 1
                    idx_str = str(version_no).zfill(2)

                    cues = base_cues
                    script_text = base_script_text
                    # Chỉ build lại SRT nếu nguồn KHÔNG PHẢI là .srt (vd: .txt)
                    if target_duration:
                        need_build_srt= True
                    else:
                        need_build_srt = original_ext != ".srt"

                    # TTS đọc từ file gốc
                    synth_source_path = original_path

                    stem = _stem_for(version_no)

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
                        genderCloneSave=genderCloneSave if enable_clone_save else None,
                        out_wav_path=str(version_base_wav),
                        ref_audio=clone_audio if enable_clone else None,
                        ref_text=ref_text if enable_clone else None,
                        language= language if language else "vi",
                        instruct=instruct or None,
                        voices_dir=str(APP_DIR / "voices"),
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


















    #Download video

    # ==================================================
    # DOWNLOAD CALLBACK
    # ==================================================


















 


    #     """Gọi từ JS khi người dùng bấm nút Stop."""
    #     return True  
    #     """Gọi từ JS khi người dùng bấm nút Stop."""
    #     return True    


    # TAO VIDEO
    
    #TRIM VIDEO 

    def _batch_thread_count(self, config, default=1):
        raw = (config or {}).get("threads")
        if raw is None:
            raw = (config or {}).get("thread", default)
        try:
            n = int(raw)
        except (TypeError, ValueError):
            n = default
        return max(1, n)

    
    def start_voice_server(self):
        """JS goi khi bam Mo Server o sidebar. Chi mo tien trinh, khong cho san sang."""
        return _start_voice_server()

    def check_voice_server(self):
        """JS goi de biet server da nghe chua: {connected: bool}."""
        return {"connected": _voice_server_alive()}

    #RENDER 
























    #END RENDER
    
    #GHEP VIDEO
        # END GHEP VIDEO      
    # ==================================================
    # TẠO PHỤ ĐỀ HÀNG LOẠT (whisper_utils, không socket)
    # ==================================================













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
            data = resp.json()
            # server chuẩn VieNeu trả về {"object": "list", "data": [...]}
            if isinstance(data, dict):
                data = data.get("data", [])
            if not isinstance(data, list):
                return {}
            # Server chỉ giữ giọng clone trong bộ nhớ: tắt server là mất.
            # Đăng ký lại các giọng đã lưu trên máy để chúng hiện lại trong danh sách.
            try:
                if self._reenroll_saved_voices(data):
                    resp = requests.get(f"{API_BASE_URL}/voices", timeout=TIMEOUT)
                    resp.raise_for_status()
                    data = resp.json()
                    if isinstance(data, dict):
                        data = data.get("data", [])
                    if not isinstance(data, list):
                        return {}
            except Exception:
                pass
            # ẩn giọng clone tạm thời (đăng ký nội bộ cho mỗi lần nhân bản)
            return [v for v in data if v.get("name") != vera_tts.TEMP_CLONE_NAME]
        except:
            return {}

    def _reenroll_saved_voices(self, server_voices):
        """Đăng ký lại các giọng clone đã lưu (thư mục voices/) mà server đã quên
        (vd sau khi khởi động lại). Chỉ đăng ký những giọng chưa có trên server.
        Trả về True nếu đã đăng ký lại ít nhất 1 giọng."""
        voices_dir = APP_DIR / "voices"
        if not voices_dir.is_dir():
            return False
        on_server = {v.get("name") for v in server_voices if isinstance(v, dict)}
        reenrolled = False
        for clip in sorted(voices_dir.iterdir()):
            if clip.suffix.lower() not in (".wav", ".mp3", ".flac", ".ogg", ".m4a"):
                continue
            name = clip.stem
            if not name or name == vera_tts.TEMP_CLONE_NAME or name in on_server:
                continue
            try:
                meta = vera_tts._load_voice_meta(str(voices_dir), name)
                vera_tts._enroll_voice(name, str(clip),
                                      (meta or {}).get("description", "") or "")
                reenrolled = True
            except Exception:
                continue
        return reenrolled

















def _set_loading_msg(window, text):
    try:
        window.evaluate_js(
            f'document.getElementById("msg").innerText = {json.dumps(text)};'
        )
    except Exception:
        pass


def _init_background(window):
    """Chạy sau khi cửa sổ loading đã hiện: khởi động Server Voice, rồi chuyển sang trang đăng nhập."""
    # 1. Khởi động Server Voice (thay cho whisper_utils.init_models trước đây —
    #    whisper giờ tự load khi cần dùng, xem whisper_utils._acquire_model).
    _set_loading_msg(window, "Đang khởi động Server Voice…")
    res = _start_voice_server()
    if res.get("already"):
        _set_loading_msg(window, "Server Voice đã chạy sẵn.")
    elif res.get("ok"):
        if _wait_voice_server(timeout_s=120):
            _set_loading_msg(window, "Server Voice đã sẵn sàng.")
        else:
            _set_loading_msg(window, "Server Voice chưa lên kịp — vào app rồi bấm Mở Server ở sidebar.")
    else:
        _set_loading_msg(window, "Không mở được Server Voice: " + str(res.get("error", "")))
    # 2. Vào trang đăng nhập (server lỗi cũng vẫn vào app, mở tay từ sidebar sau).
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
        "Sub Generator Studio",
        str(RESOURCE_DIR / "web" / "loading.html"),
        js_api=api,
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
        x=x,
        y=y,
        min_size=(300, 300),
    )

    api.set_window(window)

    DEBUG_MODE = not getattr(sys, "frozen", False)
    window.events.shown += lambda: set_window_icon(window)
    window.events.closing += api.on_window_closing
    webview.start(_init_background, window, debug=DEBUG_MODE)
if __name__ == "__main__":
    main()
