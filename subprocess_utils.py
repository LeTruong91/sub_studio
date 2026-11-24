# subprocess_utils.py
import subprocess
import sys

if sys.platform == "win32":
    NO_WINDOW_FLAGS = subprocess.CREATE_NO_WINDOW
else:
    NO_WINDOW_FLAGS = 0


def _apply_hidden(kwargs):
    """Ẩn cửa sổ console (ffmpeg, powershell, wmic) khi app --windowed."""
    if sys.platform != "win32":
        return kwargs
    flags = int(kwargs.get("creationflags") or 0) | NO_WINDOW_FLAGS
    kwargs["creationflags"] = flags
    si = kwargs.get("startupinfo")
    if si is None:
        si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = 0
    kwargs["startupinfo"] = si
    return kwargs


def run_hidden(cmd, **kwargs):
    """Wrapper cho subprocess.run, tự động ẩn console trên Windows."""
    return subprocess.run(cmd, **_apply_hidden(kwargs))


def popen_hidden(cmd, **kwargs):
    """Wrapper cho subprocess.Popen, tự động ẩn console trên Windows."""
    return subprocess.Popen(cmd, **_apply_hidden(kwargs))
