import subprocess
import json
import os
import urllib.parse
import requests

URL_API = "https://script.google.com/macros/s/AKfycbyGPkDJl7BO70Qkcs3LAPiLfsfVBa8kyykZ4LXl-05MfQZze92C-UDOMUxeq27miKXRYg/exec"

REMEMBER_FILE = os.path.join(os.path.expanduser("~"), ".account_remember.json")


def get_uuid() -> str:
    """Tương đương getUUID() bên C# (wmic csproduct get UUID)."""
    try:
        result = subprocess.run(
            ["wmic", "csproduct", "get", "UUID"],
            capture_output=True, text=True, timeout=5
        )
        lines = [l.strip() for l in result.stdout.splitlines() if l.strip()]
        uuid_val = lines[1] if len(lines) > 1 else ""
        return uuid_val.replace(" ", "").replace("\r\r\n", "")
    except Exception:
        return ""


def login(username: str, password: str) -> dict:
    """
    Tương đương Account.Login(username, password, uuid) bên C#.
    GET {url_api}?uuid=...&username=...&password=...
    Response JSON có: valid, username, status, time, message
    """
    uuid_val = get_uuid()
    params = {
        "uuid": uuid_val,
        "username": username,
        "password": password,
    }
    url = f"{URL_API}?{urllib.parse.urlencode(params)}"

    info = {
        "valid": False,
        "username": "",
        "status": False,
        "timeexit": 0,   # map từ field "time" của server
        "message": "",
    }

    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()

        info["valid"] = bool(data.get("valid", False))
        info["username"] = data.get("username", "") or ""
        info["status"] = bool(data.get("status", False))
        info["timeexit"] = int(data.get("time", 0) or 0)
        info["message"] = data.get("message", "") or ""
    except Exception as ex:
        info["message"] = f"Đã có lỗi xảy ra. Vui lòng thực hiện lại"

    return info


def register(email: str, username: str, password: str) -> dict:
    """
    Tương đương Account.Register(...) bên C#.
    POST JSON: { uuid, email, username, password, active: false }
    Response JSON: { success, message }
    """
    uuid_val = get_uuid()
    payload = {
        "uuid": uuid_val,
        "email": email,
        "username": username,
        "password": password,
        "active": False,
    }

    result = {"status": False, "message": ""}
    try:
        resp = requests.post(URL_API, json=payload, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        result["status"] = bool(data.get("success", False))
        result["message"] = data.get("message", "") or ""
    except Exception as ex:
        result["status"] = False
        result["message"] = str(ex)

    return result


def save_remember(username: str, password: str):
    with open(REMEMBER_FILE, "w", encoding="utf-8") as f:
        json.dump({"username": username, "password": password, "remember": True}, f)


def clear_remember():
    if os.path.exists(REMEMBER_FILE):
        os.remove(REMEMBER_FILE)


def load_remember() -> dict:
    if os.path.exists(REMEMBER_FILE):
        try:
            with open(REMEMBER_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"username": "", "password": "", "remember": False}