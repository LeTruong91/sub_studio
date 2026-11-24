
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
import paraphrase_srt
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
PARAPHRASE_DIR = OUTPUT_DIR / "paraphrased"
FONT_DIR = os.path.join(RESOURCE_DIR, "web", "fonts") 
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
            return resp.json()
        except:
            return {}

















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
