
import os
import re
import json
import threading
import unicodedata
import subprocess
import traceback
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote
import yt_dlp
import sys
from subprocess_utils import run_hidden

if getattr(sys, "frozen", False):
    # Đang chạy từ file exe đã build (PyInstaller)
    BASE_DIR = Path(sys.executable).resolve().parent
else:
    # Đang chạy bằng python main.py (dev mode)
    BASE_DIR = Path(__file__).resolve().parent

FFMPEG_EXE = BASE_DIR / "ffmpeg" / "ffmpeg.exe"
FFPROBE_EXE = BASE_DIR / "ffmpeg" / "ffprobe.exe"
LOG_FILE = BASE_DIR / "download_debug.log"


def normalize_socks5_proxy(line):
    """ip:port:username:pass -> socks5://username:pass@ip:port."""
    text = str(line or "").strip()
    if not text or text.startswith("#"):
        return ""
    if "://" in text:
        return text
    parts = text.split(":")
    if len(parts) >= 4 and parts[0] and parts[1].isdigit():
        host, port, user = parts[0], parts[1], parts[2]
        password = ":".join(parts[3:])
        return "socks5://{user}:{password}@{host}:{port}".format(
            user=quote(user, safe=""),
            password=quote(password, safe=""),
            host=host,
            port=port,
        )
    if "@" in text:
        return "socks5://" + text
    if len(parts) == 2 and parts[0] and parts[1].isdigit():
        return "socks5://{0}:{1}".format(parts[0], parts[1])
    return "socks5://" + text


def user_exe_dir() -> Path:
    """Thư mục file exe người dùng bấm. Onefile giải nén ra TEMP nên không dùng sys.executable."""
    argv0 = os.path.abspath(sys.argv[0] or "")
    if sys.platform == "win32" and not os.path.exists(argv0) and not argv0.lower().endswith(".exe"):
        if os.path.exists(argv0 + ".exe"):
            argv0 += ".exe"
    path = Path(argv0)
    if path.suffix.lower() == ".exe":
        return path.resolve().parent
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


COOKIE_DIR = user_exe_dir() / "cookies"


class FFmpegError(RuntimeError):
    pass


class DownloadManager:

    def __init__(self):

        self.failed_urls = []

        self.failed_urls_lock = threading.Lock()

        self.stop_event = threading.Event()

        self.progress = 0
        self.total = 0
        self.completed = 0

        self.on_log = None
        self.on_progress = None
        self.on_file_progress = None
        self.on_done = None
        self.on_saved = None
        self.saved_files = []
        self.saved_sources = {}
        self.saved_files_lock = threading.Lock()
        self._yt_auth_opts = None
        self._yt_auth_lock = threading.Lock()
        self.ffmpeg_path = FFMPEG_EXE
        self.ffprobe_path = FFPROBE_EXE
        self.encode_mode = "gpu"

    # ---------------- LOG ----------------

    def log(self, text):
        """Ghi log ra file (an toàn UTF-8) + gửi lên UI nếu có."""
        line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {text}"

        # Ghi ra file, không bao giờ để lỗi log làm crash app
        try:
            with open(LOG_FILE, "a", encoding="utf-8", errors="replace") as f:
                f.write(line + "\n")
        except Exception:
            pass

        # In ra console nếu có (bọc an toàn, tránh UnicodeEncodeError khi chạy exe --windowed)
        try:
            print(line, flush=True)
        except Exception:
            pass

        if self.on_log:
            try:
                self.on_log(text)
            except Exception:
                pass

    def log_exception(self, prefix, ex):
        """Ghi log kèm traceback đầy đủ để debug chính xác nguyên nhân."""
        tb = traceback.format_exc()
        self.log(f"{prefix}: {ex}")
        try:
            with open(LOG_FILE, "a", encoding="utf-8", errors="replace") as f:
                f.write(tb + "\n")
        except Exception:
            pass

    def _emit_done(self):
        if not self.on_done:
            return
        try:
            self.on_done()
        except Exception:
            pass

    # ---------------- STOP ----------------

    def stop(self):
        self.stop_event.set()
        self.log("⛔ Stop requested")

    # ---------------- FFMPEG HELPER ----------------

    def _run(self, cmd):
        result = run_hidden(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode != 0:
            raise FFmpegError(result.stderr.decode("utf-8", errors="ignore"))
        return result

    # ---------------- FILENAME ----------------

    def _is_icon_char(self, ch):
        o = ord(ch)
        if o in (0x200D, 0xFE0E, 0xFE0F, 0x20E3):
            return True
        if 0x1F000 <= o <= 0x1FAFF or 0x2600 <= o <= 0x27BF or 0x2190 <= o <= 0x21FF:
            return True
        if 0x2300 <= o <= 0x23FF or 0x2B00 <= o <= 0x2BFF or 0xFE00 <= o <= 0xFE0F:
            return True
        return unicodedata.category(ch) in ("So", "Sk", "Cs")

    def sanitize_filename(self, text, max_length=100):

        text = unicodedata.normalize("NFC", text or "")

        text = re.sub(
            r'^\s*[\d.,MKmk]+\s+views?\s+·\s+[\d.,MKmk]+\s+reactions?\s*',
            '',
            text
        )

        text = re.sub(r'#[^\s#]*', ' ', text)
        text = "".join(ch for ch in text if not self._is_icon_char(ch))

        text = re.sub(r'[\\/*?:"<>|]', "", text)

        text = re.sub(r'[\x00-\x1f\x7f]', "", text)

        text = re.sub(r'\s+', ' ', text)
        text = text.strip()
        text = text.rstrip(". ")
        return text[:max_length] if text else "video"

    def fix_tiktok_video(self, filepath):
        """
        - Đưa moov atom lên đầu file (+faststart) để phát được ngay
          trong <video> tag mà không cần tải hết file.
        - Nếu codec video là HEVC/H265 (thường không phát được trên
          nhiều webview/Chromium), tự động re-encode sang H.264.
        """

        if not filepath or not os.path.exists(filepath):
            return filepath

        try:
            codec = self.get_video_codec(filepath)
        except Exception as ex:
            self.log_exception("⚠️ Lỗi đọc codec, bỏ qua xử lý video", ex)
            return filepath

        needs_reencode = codec in ("hevc", "h265")
        self.log(f"ffmpeg path: {self.ffmpeg_path}")

        tmp_path = filepath + ".fixed.mp4"
        backup_path = filepath + ".bak"

        try:

            if needs_reencode:

                self.log(f"🔄 Phát hiện codec {codec}, đang chuyển sang H.264...")
                cmd = self._h264_reencode_cmd(filepath, tmp_path)
                self.log(f"🎬 Encode: {'GPU (NVENC)' if self._want_gpu() else 'CPU (x264)'}")

            else:

                # chỉ remux, không encode lại -> rất nhanh, không mất chất lượng
                cmd = [
                    str(self.ffmpeg_path),
                    "-y",
                    "-i", filepath,
                    "-c", "copy",
                    "-movflags", "+faststart",
                    tmp_path
                ]

            try:
                result = self._run(cmd)
            except FFmpegError as enc_err:
                if needs_reencode and self._want_gpu():
                    self.log("⚠️ GPU encode lỗi, chuyển sang CPU (libx264)...")
                    if os.path.exists(tmp_path):
                        os.remove(tmp_path)
                    cmd = self._h264_reencode_cmd(filepath, tmp_path, force_cpu=True)
                    result = self._run(cmd)
                else:
                    raise

            if result.returncode != 0 or not os.path.exists(tmp_path):

                stderr_text = result.stderr.decode("utf-8", errors="ignore") if result.stderr else ""
                self.log(f"⚠️ ffmpeg lỗi, giữ file gốc: {stderr_text[-500:]}")

                if os.path.exists(tmp_path):
                    os.remove(tmp_path)

                return filepath

            # FIX: không xoá file gốc trước rồi mới rename file mới vào.
            # Nếu rename thất bại giữa chừng (hết dung lượng, quyền file...)
            # file gốc sẽ mất vĩnh viễn. Thay vào đó: đổi tên file gốc
            # thành backup trước, chỉ xoá backup sau khi thay thế thành công,
            # và khôi phục lại nếu có lỗi.
            os.replace(filepath, backup_path)

            try:
                os.replace(tmp_path, filepath)
            except Exception:
                # rollback: khôi phục file gốc nếu thay thế thất bại
                os.replace(backup_path, filepath)
                raise

            os.remove(backup_path)

            self.log(f"✅ Đã xử lý xong file để xem được trên preview: {os.path.basename(filepath)}")

        except Exception as ex:

            self.log_exception("⚠️ Lỗi xử lý ffmpeg", ex)

            if os.path.exists(tmp_path):
                os.remove(tmp_path)

        return filepath

    def strip_video_metadata(self, filepath):
        """Xóa title, mô tả, chapter và tag trong moov. Giữ nguyên hình và tiếng."""
        if not filepath or not os.path.exists(filepath):
            return filepath
        if not os.path.exists(self.ffmpeg_path):
            self.log("⚠️ Không thấy ffmpeg, bỏ qua xóa metadata")
            return filepath

        tmp_path = filepath + ".nometa.mp4"
        backup_path = filepath + ".metabak"
        cmd = [
            str(self.ffmpeg_path),
            "-y",
            "-i", filepath,
            "-map", "0:v",
            "-map", "0:a?",
            "-map_metadata", "-1",
            "-map_chapters", "-1",
            "-c", "copy",
            "-fflags", "+bitexact",
            "-movflags", "+faststart",
            tmp_path,
        ]
        try:
            self._run(cmd)
            if not os.path.exists(tmp_path) or os.path.getsize(tmp_path) < 1:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
                self.log("⚠️ Xóa metadata không ra file, giữ bản gốc")
                return filepath
            before = self.media_duration_seconds(filepath)
            after = self.media_duration_seconds(tmp_path)
            if before >= 20 and after > 0 and after < before * 0.9:
                os.remove(tmp_path)
                self.log(
                    "⚠️ Xóa metadata làm ngắn video ({0:.0f}s → {1:.0f}s), giữ file gốc".format(before, after)
                )
                return filepath
            os.replace(filepath, backup_path)
            try:
                os.replace(tmp_path, filepath)
            except Exception:
                os.replace(backup_path, filepath)
                raise
            os.remove(backup_path)
            filepath = self._rename_clean_title(filepath)
            self.log(f"✅ Đã xóa metadata: {os.path.basename(filepath)}")
        except Exception as ex:
            self.log_exception("⚠️ Không xóa được metadata, giữ file gốc", ex)
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
        return filepath

    def _rename_clean_title(self, filepath):
        folder, name = os.path.split(filepath)
        stem, ext = os.path.splitext(name)
        clean = self.sanitize_filename(stem, max_length=150)
        if not clean or clean == stem:
            return filepath
        dest = os.path.join(folder, clean + ext)
        if os.path.abspath(dest) == os.path.abspath(filepath):
            return filepath
        n = 2
        while os.path.exists(dest):
            dest = os.path.join(folder, f"{clean}_{n}{ext}")
            n += 1
        os.replace(filepath, dest)
        self.log(f"✅ Đổi tên: {name} → {os.path.basename(dest)}")
        return dest

    def resolve_downloaded_path(self, ydl, info, save_dir, title):
        """
        yt_dlp có thể merge/convert đuôi file khác với lúc extract_info,
        nên cần dò lại file thực tế đã tải ra trong save_dir.
        """

        try:

            filename = ydl.prepare_filename(info)

            base, _ = os.path.splitext(filename)

            candidate = base + ".mp4"

            if os.path.exists(candidate):
                return candidate

            if os.path.exists(filename):
                return filename

            part_candidate = candidate + ".part"
            if os.path.exists(part_candidate):
                return part_candidate

        except Exception as ex:
            self.log_exception("⚠️ Lỗi resolve_downloaded_path", ex)

        # fallback: lấy file mp4 đã ghép. Bỏ file trung gian .f299.mp4 nếu đã có bản ghép.
        try:
            title_norm = unicodedata.normalize("NFC", title)
            format_file = re.compile(r"\.f\d+\.mp4$", re.IGNORECASE)
            finished = []
            part_hit = None
            for f in os.listdir(save_dir):
                f_norm = unicodedata.normalize("NFC", f)
                if not f_norm.startswith(title_norm):
                    continue
                lower = f.lower()
                full = os.path.join(save_dir, f)
                if lower.endswith(".mp4"):
                    finished.append(full)
                elif lower.endswith(".mp4.part"):
                    part_hit = full
            plain = [path for path in finished if not format_file.search(os.path.basename(path))]
            pool = plain or finished
            if pool:
                return max(pool, key=lambda path: os.path.getsize(path) if os.path.exists(path) else 0)
            if part_hit:
                return part_hit
        except Exception as ex:
            self.log_exception("⚠️ Lỗi khi liệt kê thư mục", ex)

        return None

    def promote_finished_part(self, path, save_dir, title):
        """Đổi file tạm .mp4.part thành .mp4 khi tải đã xong nhưng đổi tên bị kẹt."""
        candidates = []
        if path and str(path).lower().endswith(".part") and os.path.exists(path):
            candidates.append(path)
        title_norm = unicodedata.normalize("NFC", title or "")
        try:
            for name in os.listdir(save_dir):
                name_norm = unicodedata.normalize("NFC", name)
                if title_norm and not name_norm.startswith(title_norm):
                    continue
                if name.lower().endswith(".mp4.part"):
                    full = os.path.join(save_dir, name)
                    if full not in candidates:
                        candidates.append(full)
        except Exception as ex:
            self.log_exception("⚠️ Lỗi dò file .part", ex)

        final_path = path
        for part in candidates:
            if not os.path.exists(part) or os.path.getsize(part) < 1:
                continue
            final = part[:-5] if part.lower().endswith(".part") else part
            try:
                if os.path.exists(final):
                    if os.path.getsize(final) >= os.path.getsize(part):
                        os.remove(part)
                        self.log(f"Đã xóa file tạm: {os.path.basename(part)}")
                        final_path = final
                        continue
                    os.remove(final)
                os.replace(part, final)
                self.log(f"✅ Đổi tên {os.path.basename(part)} → {os.path.basename(final)}")
                final_path = final
            except Exception as ex:
                self.log_exception("⚠️ Không đổi được đuôi .part", ex)
                final_path = part if os.path.exists(part) else final_path
        if final_path and str(final_path).lower().endswith(".mp4"):
            return final_path
        return path

    def merge_split_parts(self, save_dir, title):
        """Video dài tải thành part hình .fNNN và part tiếng. Ghép lại thành một mp4."""
        title_norm = unicodedata.normalize("NFC", title or "")
        if not title_norm or not os.path.isdir(save_dir):
            return None
        videos = []
        audios = []
        try:
            names = os.listdir(save_dir)
        except Exception:
            return None
        for name in names:
            name_norm = unicodedata.normalize("NFC", name)
            if not name_norm.startswith(title_norm):
                continue
            lower = name.lower()
            path = os.path.join(save_dir, name)
            if re.search(r"\.f\d+\.(mp4|webm|mkv)$", lower):
                videos.append(path)
            elif re.search(r"\.f\d+\.(m4a|webm|opus|mp3|aac)$", lower):
                audios.append(path)
        if not videos or not audios:
            return None
        video = max(videos, key=lambda path: os.path.getsize(path) if os.path.exists(path) else 0)
        audio = max(audios, key=lambda path: os.path.getsize(path) if os.path.exists(path) else 0)
        dest = os.path.join(save_dir, title_norm + ".mp4")
        tmp = dest + ".merge.mp4"
        self.log(
            "Đang ghép part: {0} + {1}".format(os.path.basename(video), os.path.basename(audio))
        )
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
            self._run([
                str(self.ffmpeg_path), "-y",
                "-i", video,
                "-i", audio,
                "-map", "0:v:0",
                "-map", "1:a:0",
                "-c", "copy",
                "-movflags", "+faststart",
                tmp,
            ])
            if not os.path.exists(tmp) or os.path.getsize(tmp) < 1:
                if os.path.exists(tmp):
                    os.remove(tmp)
                self.log("⚠️ Ghép part không ra file")
                return None
            if os.path.exists(dest):
                os.remove(dest)
            os.replace(tmp, dest)
            self.log("✅ Đã ghép part thành: " + os.path.basename(dest))
            return dest
        except Exception as ex:
            self.log_exception("⚠️ Không ghép được part hình và tiếng", ex)
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except Exception:
                    pass
            return None

    # ---------------- KIỂM TRA CODEC BẰNG FFPROBE ----------------

    def get_video_codec(self, filepath):

        try:
            cmd = [
                str(self.ffprobe_path),
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=codec_name",
                "-of", "json",
                str(filepath)
            ]

            result = self._run(cmd)

            data = json.loads(result.stdout or "{}")

            streams = data.get("streams", [])

            if streams:
                return streams[0].get("codec_name", "").lower()

        except Exception as ex:

            self.log_exception("⚠️ Không đọc được codec", ex)

        return ""

    def media_duration_seconds(self, filepath):
        try:
            cmd = [
                str(self.ffprobe_path),
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(filepath),
            ]
            result = self._run(cmd)
            return float((result.stdout or "0").strip() or 0)
        except Exception:
            return 0.0

    def _want_gpu(self):
        return (self.encode_mode or "gpu").lower() in ("gpu", "nvenc", "h264_nvenc")

    def _h264_reencode_cmd(self, src, dst, force_cpu=False):
        use_gpu = self._want_gpu() and not force_cpu
        cmd = [str(self.ffmpeg_path), "-y", "-i", src]
        if use_gpu:
            cmd.extend([
                "-c:v", "h264_nvenc",
                "-preset", "p4",
                "-cq", "23",
                "-pix_fmt", "yuv420p",
            ])
        else:
            cmd.extend([
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", "23",
                "-pix_fmt", "yuv420p",
            ])
        cmd.extend(["-c:a", "aac", "-movflags", "+faststart", dst])
        return cmd

    def detect_platform(self, url):
        u = (url or "").lower()
        if "douyin.com" in u or "iesdouyin.com" in u:
            return "douyin"
        if "xiaohongshu.com" in u or "xhslink.com" in u:
            return "xiaohongshu"
        if "instagram.com" in u:
            return "instagram"
        if "youtube.com" in u or "youtu.be" in u:
            return "youtube"
        if "facebook.com" in u or "fb.watch" in u or "fb.com" in u:
            return "facebook"
        if "tiktok.com" in u:
            return "tiktok"
        return ""

    def _cookie_targets(self, url, platform):
        u = (url or "").lower()
        p = (platform or "").lower() or self.detect_platform(url)
        names = []
        if p == "douyin" or "douyin.com" in u or "iesdouyin.com" in u:
            names.append("douyin")
        if p == "xiaohongshu" or "xiaohongshu.com" in u or "xhslink.com" in u:
            names.append("xiaohongshu")
        if p == "instagram" or "instagram.com" in u:
            names.append("instagram")
        if p == "youtube" or "youtube.com" in u or "youtu.be" in u:
            names.append("youtube")
        return names

    def _cookie_file_candidates(self, names):
        files = []
        COOKIE_DIR.mkdir(parents=True, exist_ok=True)
        exe_dir = user_exe_dir()
        for name in names:
            for path in (exe_dir / "cookies" / f"{name}.txt", exe_dir / f"{name}_cookies.txt"):
                if path.is_file() and path not in files:
                    files.append(path)
        return files

    def _cookie_opt_list(self, url, platform):
        names = self._cookie_targets(url, platform)
        if not names:
            return []
        variants = []
        for path in self._cookie_file_candidates(names):
            variants.append({"cookiefile": str(path)})
        for browser in ("edge", "chrome", "firefox", "brave"):
            variants.append({"cookiesfrombrowser": (browser,)})
        return variants

    def _ydl_common_opts(self, url, platform, proxy=None):
        opts = {
            "quiet": True,
            "no_warnings": True,
            "ffmpeg_location": str(Path(self.ffmpeg_path).parent),
            "socket_timeout": 45,
            "retries": 2,
        }
        if proxy:
            opts["proxy"] = proxy
        if self.detect_platform(url) == "youtube" or (platform or "").lower() == "youtube":
            opts["js_runtimes"] = {"node": {}}
        names = self._cookie_targets(url, platform)
        if "douyin" in names:
            opts["http_headers"] = {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/122.0.0.0 Safari/537.36"
                ),
                "Referer": "https://www.douyin.com/",
            }
        return opts

    def _is_cookie_error(self, ex):
        msg = str(ex or "")
        low = msg.lower()
        return (
            "fresh cookies" in low
            or "cookies" in low
            or "cookie database" in low
            or "dpapi" in low
            or "ttwid" in low
            or "login" in low
            or "page needs to be reloaded" in low
            or self._is_youtube_cookie_error(ex)
        )

    def _is_youtube_cookie_error(self, ex):
        low = str(ex or "").lower()
        return (
            "not a bot" in low
            or "sign in to confirm" in low
            or "cookies-from-browser" in low
            or "exporting youtube cookies" in low
            or "page needs to be reloaded" in low
            or "dpapi" in low
            or "cookie database" in low
        )

    def _pull_info(self, url, opts):
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        self._active_cookie_opts = {
            k: opts[k] for k in ("cookiefile", "cookiesfrombrowser", "http_headers") if k in opts
        }
        return info

    def _extract_info(self, url, platform, proxy=None):
        base = self._ydl_common_opts(url, platform, proxy)
        variants = self._cookie_opt_list(url, platform)
        names = self._cookie_targets(url, platform)
        if "youtube" in names:
            return self._extract_youtube_info(url, base, variants)
        attempts = [dict(base, **v) for v in variants] if variants else [base]
        last_err = None
        for opts in attempts:
            cookie_desc = opts.get("cookiefile") or opts.get("cookiesfrombrowser") or "không cookie"
            try:
                info = self._pull_info(url, opts)
                if variants:
                    self.log(f"🍪 Cookie OK: {cookie_desc}")
                return info
            except Exception as ex:
                last_err = ex
                if variants and self._is_cookie_error(ex):
                    self.log(f"⚠️ Cookie chưa dùng được ({cookie_desc})")
                    continue
                raise
        cookie_hint = COOKIE_DIR / "douyin.txt"
        self.log(
            "❌ Douyin/XHS cần cookie mới. Mở Edge/Chrome vào douyin.com một lần rồi tải lại, "
            f"hoặc xuất Netscape cookies vào: {cookie_hint}"
        )
        raise last_err

    def _extract_youtube_info(self, url, base, variants):
        mode = self._yt_auth_opts
        if isinstance(mode, dict):
            opts = dict(base, **mode) if mode else dict(base)
            return self._pull_info(url, opts)
        if mode == "exhausted":
            return self._pull_info(url, dict(base))

        with self._yt_auth_lock:
            mode = self._yt_auth_opts
            if isinstance(mode, dict) or mode == "exhausted":
                probed = None
            else:
                probed, mode = self._probe_youtube_auth(url, base, variants)
                self._yt_auth_opts = mode
                if probed is not None:
                    return probed
        if isinstance(mode, dict):
            opts = dict(base, **mode) if mode else dict(base)
            return self._pull_info(url, opts)
        return self._pull_info(url, dict(base))

    def _probe_youtube_auth(self, url, base, variants):
        try:
            info = self._pull_info(url, dict(base))
            return info, {}
        except Exception as ex:
            if not (self._is_youtube_cookie_error(ex) or self._is_cookie_error(ex)):
                raise
            last_err = ex

        for extra in variants:
            opts = dict(base, **extra)
            cookie_desc = opts.get("cookiefile") or opts.get("cookiesfrombrowser") or "không cookie"
            try:
                info = self._pull_info(url, opts)
                self.log(f"🍪 Cookie YouTube OK: {cookie_desc}")
                return info, extra
            except Exception as ex:
                last_err = ex
                if self._is_youtube_cookie_error(ex) or self._is_cookie_error(ex):
                    continue
                raise
        return None, "exhausted"

    # ---------------- DOWNLOAD 1 VIDEO ----------------

    def download_video(self, url, save_dir, platform=None, proxy=None):

        if self.stop_event.is_set():
            return

        info = None
        safe_title = "video"
        platform = self.detect_platform(url) or platform

        try:
            is_tiktok = "tiktok.com" in url.lower()
            is_douyin = (
                (platform or "").lower() == "douyin"
                or "douyin.com" in url.lower()
                or "iesdouyin.com" in url.lower()
            )
            needs_web_fix = is_tiktok or is_douyin
            is_shorts = "youtube.com" in url.lower() or "youtu.be" in url.lower()
            self._active_cookie_opts = {}
            cookie_extra = {}

            if is_tiktok:
                info = self._extract_info(url, platform, proxy)
                cookie_extra = dict(self._active_cookie_opts)
                has_mp4 = False
                formats = info.get("formats", [])
                for fmt in formats:
                    ext = fmt.get("ext", "").lower()
                    vcodec = fmt.get("vcodec", "").lower()
                    if ext == "mp4" and vcodec != "none":
                        has_mp4 = True
                        break
                if not has_mp4:
                    self.log(f"⏭️ SKIP: {url} | NO FOUND MP4")
                    return

            if is_shorts:
                info = self._extract_info(url, platform, proxy)
                cookie_extra = dict(self._active_cookie_opts)
                safe_title = self.sanitize_filename(info.get("title", "video"))
                ydl_opts = {
                    **self._ydl_common_opts(url, platform, proxy),
                    **cookie_extra,
                    "format": "(bestvideo[vcodec^=avc1][ext=mp4]/best[vcodec^=avc1][ext=mp4])"
                    "+bestaudio[ext=m4a]/best[ext=mp4]/best",
                    "merge_output_format": "mp4",
                    "outtmpl": os.path.join(save_dir, f"{safe_title}.%(ext)s"),
                    "noplaylist": True,
                    "ignoreerrors": False,
                    "noprogress": True,
                    "fragment_retries": 10,
                    "retries": 5,
                }
            else:
                info = self._extract_info(url, platform, proxy)
                cookie_extra = dict(self._active_cookie_opts)
                safe_title = self.sanitize_filename(info.get("title", "video"))
                ydl_opts = {
                    **self._ydl_common_opts(url, platform, proxy),
                    **cookie_extra,
                    "format": "bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best",
                    "merge_output_format": "mp4",
                    "outtmpl": os.path.join(save_dir, f"{safe_title}.%(ext)s"),
                    "noplaylist": True,
                    "retries": 5,
                    "fragment_retries": 5,
                    "socket_timeout": 80,
                    "ignoreerrors": not bool(self._cookie_targets(url, platform)),
                    "noprogress": True,
                    "compat_opts": ["abort-on-unavailable-fragment"],
                }
                if needs_web_fix:
                    ydl_opts["format"] = (
                        "(bestvideo[vcodec^=avc1][ext=mp4]/best[vcodec^=avc1][ext=mp4])"
                        "+bestaudio[ext=m4a]/best[ext=mp4]/best"
                    )

            _last_file_percent = {"n": -1}

            def _file_progress(data):
                if data.get("status") != "downloading":
                    return
                total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
                done = data.get("downloaded_bytes") or 0
                if not total:
                    return
                percent = max(0, min(100, int(done * 100 / total)))
                if percent == _last_file_percent["n"]:
                    return
                _last_file_percent["n"] = percent
                if self.on_file_progress:
                    try:
                        self.on_file_progress(safe_title, percent)
                    except Exception:
                        pass

            ydl_opts["progress_hooks"] = [_file_progress]

            downloaded_path = None

            if not self.stop_event.is_set():

                with yt_dlp.YoutubeDL(ydl_opts) as ydl:

                    ydl.download([url])
                    merged = self.merge_split_parts(save_dir, safe_title)
                    downloaded_path = merged or self.resolve_downloaded_path(
                        ydl, info, save_dir, safe_title
                    )
                    downloaded_path = self.promote_finished_part(
                        downloaded_path, save_dir, safe_title
                    )

            if needs_web_fix and downloaded_path:
                label = "Douyin" if is_douyin else "TikTok"
                self.log(f"Đã tải {label}: {downloaded_path}")
                self.fix_tiktok_video(downloaded_path)

            if downloaded_path:
                expected = 0.0
                try:
                    expected = float((info or {}).get("duration") or 0)
                except (TypeError, ValueError):
                    expected = 0.0
                actual = self.media_duration_seconds(downloaded_path)
                self.log("Độ dài file tải: {0:.0f}s / video gốc: {1:.0f}s".format(actual, expected))
                if expected >= 30 and actual > 0 and actual < expected * 0.9:
                    self.log(
                        "❌ File tải bị thiếu ({0:.0f}s), video gốc dài {1:.0f}s. Không cắt video lúc tải, bỏ file này.".format(
                            actual, expected
                        )
                    )
                    try:
                        os.remove(downloaded_path)
                    except Exception:
                        pass
                    with self.failed_urls_lock:
                        self.failed_urls.append(url)
                    return

                self.strip_video_metadata(downloaded_path)
                with self.saved_files_lock:
                    saved = os.path.abspath(downloaded_path)
                    self.saved_files.append(saved)
                    self.saved_sources[saved] = url
                if self.on_saved:
                    try:
                        self.on_saved(url)
                    except Exception:
                        pass
                self.log(f"✅ {url}")
            elif not self.stop_event.is_set():
                self.log(f"❌ {url} | Không thấy file sau khi tải")
                with self.failed_urls_lock:
                    self.failed_urls.append(url)

        except Exception as ex:

            if self._is_youtube_cookie_error(ex):
                self.log(
                    f"❌ {url} | Cần cập nhật cookie YouTube. "
                    "Đăng nhập YouTube trên Edge hoặc Chrome, "
                    "hoặc xuất cookie vào cookies/youtube.txt"
                )
                try:
                    with open(LOG_FILE, "a", encoding="utf-8", errors="replace") as f:
                        f.write(str(ex) + "\n")
                except Exception:
                    pass
            else:
                self.log_exception(f"❌ {url} | Đã có lỗi xảy ra", ex)

            with self.failed_urls_lock:
                self.failed_urls.append(url)

        finally:

            self.completed += 1

            self.progress = int(
                self.completed * 100 / self.total
            ) if self.total else 0

            if self.on_progress:
                try:
                    self.on_progress(
                        self.progress,
                        self.completed,
                        self.total
                    )
                except Exception as ex:
                    self.log_exception("⚠️ Lỗi callback on_progress", ex)

    # ---------------- START ----------------

    def start(self,
              urls,
              save_folder,
              threads=4, platform=None, encode_mode="gpu", url_dirs=None, proxies=None):

        self.failed_urls.clear()
        with self.saved_files_lock:
            self.saved_files.clear()
            self.saved_sources.clear()
        self._yt_auth_opts = None

        self.stop_event.clear()
        self.encode_mode = (encode_mode or "gpu").lower()

        self.progress = 0
        self.completed = 0

        try:
            os.makedirs(save_folder, exist_ok=True)
        except Exception as ex:
            self.log_exception(f"❌ Không thể tạo thư mục lưu: {save_folder}", ex)
            self._emit_done()
            return {
                "success": 0,
                "failed": 0,
                "failed_urls": []
            }

        # Nếu truyền vào là chuỗi thì chuyển thành list
        if isinstance(urls, str):
            urls = [
                x.strip()
                for x in urls.splitlines()
                if x.strip()
            ]

        self.total = len(urls)

        if self.total == 0:
            self.log("❌ Không có URL nào.")
            self._emit_done()
            return {
                "success": 0,
                "failed": 0,
                "failed_urls": []
            }

        try:
            threads = max(1, min(100, int(threads)))
        except (TypeError, ValueError):
            threads = 1

        self.log(f"📥 Tổng video: {self.total}")
        self.log(f"🧵 Luồng chạy: {threads}")
        self.log(f"📁 Thư mục lưu: {save_folder}")
        channel_folders = sorted({str(v) for v in (url_dirs or {}).values() if str(v).strip()})
        for name in channel_folders:
            channel_path = os.path.join(save_folder, name)
            os.makedirs(channel_path, exist_ok=True)
            self.log(f"📁 Kênh {name}: {channel_path}")
        self.log(f"🎬 FFmpeg path: {self.ffmpeg_path} | Tồn tại: {os.path.exists(self.ffmpeg_path)}")
        self.log(f"⚙️ Encode HEVC→H.264: {'GPU (NVENC)' if self._want_gpu() else 'CPU (x264)'}")
        if any(self.detect_platform(u) == "douyin" for u in urls):
            self.log("ℹ️ Douyin cần cookie: mở Edge/Chrome vào douyin.com, hoặc cookies/douyin.txt")

        proxy_list = []
        for raw in proxies or []:
            item = normalize_socks5_proxy(raw)
            if item and item not in proxy_list:
                proxy_list.append(item)
        if proxy_list:
            self.log(
                f"Proxy SOCKS5: {len(proxy_list)} proxy, gán xoay vòng cho {self.total} link."
            )

        try:
            with ThreadPoolExecutor(max_workers=threads) as executor:

                futures = []
                for index, url in enumerate(urls):
                    folder = save_folder
                    channel = str((url_dirs or {}).get(url) or "").strip()
                    if channel:
                        folder = os.path.join(save_folder, channel)
                        os.makedirs(folder, exist_ok=True)
                    proxy = proxy_list[index % len(proxy_list)] if proxy_list else None
                    futures.append(
                        executor.submit(
                            self.download_video,
                            url,
                            folder,
                            platform,
                            proxy,
                        )
                    )

                for future in as_completed(futures):

                    if self.stop_event.is_set():
                        executor.shutdown(wait=False, cancel_futures=True)
                        break

                    try:
                        future.result()
                    except Exception as ex:
                        self.log_exception("⚠️ Lỗi không xác định trong thread tải", ex)

            self.log("🎉 Tải hoàn tất")
            return {
                "success": self.completed - len(self.failed_urls),
                "failed": len(self.failed_urls),
                "failed_urls": self.failed_urls
            }
        finally:
            self._emit_done()