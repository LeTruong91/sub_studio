"""
whisper_utils.py
----------------
Tạo phụ đề bằng faster-whisper. CUDA nếu có cublas64_12.dll, không thì CPU.
"""
import os
import sys
import site
import ctypes
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from queue import Queue

from faster_whisper import WhisperModel

THREADS_PER_MODEL = 4

_model_pool = Queue()
_pool_lock = threading.Lock()
_pool_initialized = False
_pool_size = 1
_active_device = "cpu"

_stopped_jobs = set()
_stop_lock = threading.Lock()


def _unique_dirs(paths):
    seen = set()
    out = []
    for p in paths:
        if not p:
            continue
        path = Path(p)
        try:
            key = str(path.resolve())
        except OSError:
            key = str(path)
        if key in seen or not path.is_dir():
            continue
        seen.add(key)
        out.append(path)
    return out


def _nvidia_bin_dirs():
    roots = []
    try:
        for sp in list(site.getsitepackages() or []) + [site.getusersitepackages()]:
            if sp:
                roots.append(Path(sp) / "nvidia")
    except Exception:
        pass
    roots.append(Path(sys.prefix) / "Lib" / "site-packages" / "nvidia")
    roots.append(
        Path(os.environ.get("USERPROFILE", ""))
        / "AppData" / "Local" / "Programs" / "Python" / "Python311" / "Lib" / "site-packages" / "nvidia"
    )
    if getattr(sys, "frozen", False):
        roots.append(Path(sys.executable).resolve().parent / "nvidia")
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            roots.append(Path(meipass) / "nvidia")

    bins = []
    for root in roots:
        for sub in (
            "cublas/bin",
            "cuda_runtime/bin",
            "cuda_nvrtc/bin",
            "cudnn/bin",
            "cufft/bin",
            "curand/bin",
            "nvjitlink/bin",
        ):
            bins.append(root / sub)

    cuda_path = os.environ.get("CUDA_PATH") or os.environ.get("CUDA_HOME")
    if cuda_path:
        bins.append(Path(cuda_path) / "bin")
    return _unique_dirs(bins)


def _add_dll_dirs(dirs):
    path_front = []
    for d in dirs:
        path_front.append(str(d))
        try:
            os.add_dll_directory(str(d))
        except (OSError, AttributeError):
            pass
    if path_front:
        os.environ["PATH"] = os.pathsep.join(path_front) + os.pathsep + os.environ.get("PATH", "")


def _preload_cuda_dlls():
    """Nạp toàn bộ DLL CUDA/cuDNN (ORT cần heuristic/engines, không chỉ cublas)."""
    dirs = _nvidia_bin_dirs()
    _add_dll_dirs(dirs)
    priority = (
        "cudart64_12.dll",
        "nvJitLink_120_0.dll",
        "nvrtc64_120_0.dll",
        "cublasLt64_12.dll",
        "cublas64_12.dll",
        "cufft64_11.dll",
        "curand64_10.dll",
        "cudnn_ops64_9.dll",
        "cudnn_graph64_9.dll",
        "cudnn_heuristic64_9.dll",
        "cudnn_engines_precompiled64_9.dll",
        "cudnn_engines_runtime_compiled64_9.dll",
        "cudnn_engines_tensor_ir64_9.dll",
        "cudnn_cnn64_9.dll",
        "cudnn_adv64_9.dll",
        "cudnn_ext64_9.dll",
        "cudnn64_9.dll",
    )
    loaded = set()
    for name in priority:
        for d in dirs:
            dll = d / name
            if not dll.exists() or name in loaded:
                continue
            try:
                ctypes.WinDLL(str(dll))
                loaded.add(name)
            except OSError:
                continue
    for d in dirs:
        for dll in sorted(d.glob("*.dll")):
            if dll.name in loaded:
                continue
            try:
                ctypes.WinDLL(str(dll))
                loaded.add(dll.name)
            except OSError:
                continue
    return "cublas64_12.dll" in loaded or _cublas_on_path()


def _cublas_on_path():
    try:
        ctypes.WinDLL("cublas64_12.dll")
        return True
    except OSError:
        return False


def _load_cublas():
    """Trả True nếu nạp được CUDA 12 (cublas + cufft cho ONNX Runtime)."""
    if _preload_cuda_dlls():
        return True
    return _cublas_on_path()


def _pick_device():
    if _load_cublas():
        return "cuda", "float16"
    return "cpu", "int8"


def _create_model(device, compute_type):
    return WhisperModel(
        "turbo",
        device=device,
        compute_type=compute_type,
        cpu_threads=THREADS_PER_MODEL,
    )


def init_models(num_models=2, device=None, compute_type=None):
    """Gọi 1 lần khi app khởi động. Thiếu cublas → CPU, không crash."""
    global _pool_initialized, _pool_size, _active_device
    with _pool_lock:
        if _pool_initialized:
            return _active_device
        if device is None or compute_type is None:
            device, compute_type = _pick_device()
        n = max(1, int(num_models or 1))
        if device == "cpu":
            n = 1
        try:
            for _ in range(n):
                _model_pool.put(_create_model(device, compute_type))
            _active_device = device
        except Exception:
            while not _model_pool.empty():
                try:
                    _model_pool.get_nowait()
                except Exception:
                    break
            device, compute_type = "cpu", "int8"
            n = 1
            _model_pool.put(_create_model(device, compute_type))
            _active_device = "cpu"
        _pool_size = n
        _pool_initialized = True
        return _active_device


def _acquire_model():
    if not _pool_initialized:
        init_models()
    return _model_pool.get()


def _release_model(model):
    _model_pool.put(model)


def stop_job(job_id):
    with _stop_lock:
        _stopped_jobs.add(job_id)


def stop_all(job_ids):
    with _stop_lock:
        _stopped_jobs.update(job_ids)


def _is_stopped(job_id):
    with _stop_lock:
        return job_id in _stopped_jobs


def _clear_stopped(job_id):
    with _stop_lock:
        _stopped_jobs.discard(job_id)


def format_time(seconds):
    ms = int((seconds - int(seconds)) * 1000)
    s = int(seconds) % 60
    m = int(seconds // 60) % 60
    h = int(seconds // 3600)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def _whisper_lang(code):
    if code is None:
        return None
    key = str(code).strip()
    if not key or key.lower() in ("auto", "none"):
        return None
    mapping = {
        "zh": "zh",
        "zh-cn": "zh",
        "zh-CN": "zh",
        "zh-hans": "zh",
        "zh-tw": "zh",
        "chinese": "zh",
        "vi": "vi",
        "en": "en",
        "ja": "ja",
        "jp": "ja",
        "ko": "ko",
        "kr": "ko",
        "id": "id",
        "th": "th",
    }
    return mapping.get(key) or mapping.get(key.lower()) or key


def _write_srt_rows(output_path, rows):
    is_srt = str(output_path).lower().endswith(".srt")
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for i, (start, end, text) in enumerate(rows, 1):
            if is_srt:
                f.write(f"{i}\n")
                f.write(f"{format_time(start)} --> {format_time(end)}\n")
                f.write((text or "") + "\n\n")
            else:
                f.write(f"{start:.2f}|{end:.2f}|{text or ''}\n")


def transcribe_one(job_id, audio_path, output_path, language="auto", vad=True,
                   on_progress=None):
    del vad
    _clear_stopped(job_id)
    model = _acquire_model()

    def emit(pct):
        if on_progress:
            try:
                on_progress(job_id, pct)
            except TypeError:
                on_progress(job_id, pct)

    try:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        primary = _whisper_lang(language)
        if primary is None:
            langs = [None, "zh", "vi"]
        else:
            langs = [primary]
            if primary != "zh":
                langs.append("zh")
            if primary != "vi":
                langs.append("vi")

        last_error = None
        for lang in langs:
            if _is_stopped(job_id):
                return {
                    "success": False,
                    "message": "Đã dừng bởi người dùng.",
                    "stopped": True,
                }
            try:
                segments, info = model.transcribe(
                    audio_path,
                    language=lang,
                    vad_filter=False,
                    beam_size=1,
                    condition_on_previous_text=False,
                )
                duration = float(getattr(info, "duration", 0) or 0)
                rows = []
                parts = []
                for i, seg in enumerate(segments, 1):
                    if _is_stopped(job_id):
                        return {
                            "success": False,
                            "message": "Đã dừng bởi người dùng.",
                            "stopped": True,
                        }
                    text = (seg.text or "").strip()
                    rows.append((seg.start, seg.end, text))
                    if text:
                        parts.append(text)
                    if duration > 0:
                        emit(min(99, max(1, int((seg.end or 0) * 100 / duration))))
                    else:
                        emit(min(99, i))
                joined = "\n".join(parts)
                if not joined:
                    last_error = RuntimeError("Whisper không ra câu nào.")
                    continue

                _write_srt_rows(output_path, rows)
                emit(100)
                return {
                    "success": True,
                    "output": output_path,
                    "message": "Tạo phụ đề thành công.",
                }
            except Exception as e:
                last_error = e
                continue

        return {
            "success": False,
            "message": str(last_error) if last_error else "Không lấy được phụ đề.",
            "stopped": False,
        }

    except Exception as e:
        return {"success": False, "message": str(e), "stopped": False}

    finally:
        _release_model(model)
        _clear_stopped(job_id)


def transcribe_batch(jobs, language="auto", vad=True, max_workers=2,
                     on_progress=None, on_file_done=None, on_file_error=None,
                     on_batch_done=None):
    def runner():
        results = []
        workers = max(1, min(int(max_workers or 1), int(_pool_size or 1), max(len(jobs), 1)))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(
                    transcribe_one,
                    job["job_id"], job["audio"], job["output"],
                    language, vad, on_progress
                ): job
                for job in jobs
            }

            for future in as_completed(futures):
                job = futures[future]
                result = future.result()
                results.append({"job_id": job["job_id"], **result})

                if result.get("stopped"):
                    continue

                if result["success"]:
                    if on_file_done:
                        on_file_done(job["job_id"], result["output"])
                else:
                    if on_file_error:
                        on_file_error(job["job_id"], result["message"])

        if on_batch_done:
            on_batch_done(results)

    threading.Thread(target=runner, daemon=True).start()
