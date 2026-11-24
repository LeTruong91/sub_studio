import sys
import threading
import mimetypes
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler


HOST = "127.0.0.1"
PORT = 9876
CHUNK_SIZE = 64 * 1024


class MediaRequestHandler(BaseHTTPRequestHandler):

    protocol_version = "HTTP/1.1"

    def do_GET(self):

        # tránh timeout khi stream video dài
        self.connection.settimeout(3600)

        url = urlparse(self.path)

        if url.path != "/file":
            self.send_error(404)
            return

        qs = parse_qs(url.query)

        if "path" not in qs:
            self.send_error(400, "Missing path")
            return

        filepath = unquote(qs["path"][0])

        file = Path(filepath)

        if not file.exists():
            self.send_error(404, "File not found")
            return

        filesize = file.stat().st_size

        mime = (
            mimetypes.guess_type(str(file))[0]
            or "application/octet-stream"
        )

        range_header = self.headers.get("Range")

        try:

            if range_header:
                self.send_partial(
                    file,
                    filesize,
                    mime,
                    range_header
                )

            else:
                self.send_full(
                    file,
                    filesize,
                    mime
                )

        except (
            ConnectionAbortedError,
            ConnectionResetError,
            BrokenPipeError
        ):
            # client đóng video giữa chừng (tua/seek, đóng tab, ...)
            pass

    def add_common_headers(self):

        self.send_header(
            "Access-Control-Allow-Origin",
            "*"
        )

        self.send_header(
            "Accept-Ranges",
            "bytes"
        )

        self.send_header(
            "Cache-Control",
            "no-cache"
        )

        self.send_header(
            "Connection",
            "keep-alive"
        )

    def send_full(self, file, filesize, mime):

        self.send_response(200)

        self.send_header(
            "Content-Type",
            mime
        )

        self.send_header(
            "Content-Length",
            str(filesize)
        )

        self.add_common_headers()

        self.end_headers()

        with open(file, "rb") as f:

            while True:

                data = f.read(CHUNK_SIZE)

                if not data:
                    break

                try:

                    self.wfile.write(data)
                    self.wfile.flush()

                except (
                    ConnectionAbortedError,
                    ConnectionResetError,
                    BrokenPipeError
                ):

                    return

    def send_partial(
        self,
        file,
        filesize,
        mime,
        range_header
    ):

        start = 0
        end = filesize - 1

        try:

            units, rng = range_header.split("=")

            if units != "bytes":
                raise Exception()

            start_str, end_str = rng.split("-")

            if start_str:
                start = int(start_str)

            if end_str:
                end = int(end_str)

        except Exception:

            self.send_error(416)
            return

        if start >= filesize:

            self.send_error(416)
            return

        if end >= filesize:

            end = filesize - 1

        length = end - start + 1

        self.send_response(206)

        self.send_header(
            "Content-Type",
            mime
        )

        self.send_header(
            "Content-Length",
            str(length)
        )

        self.send_header(
            "Content-Range",
            f"bytes {start}-{end}/{filesize}"
        )

        self.add_common_headers()

        self.end_headers()

        with open(file, "rb") as f:

            f.seek(start)

            remain = length

            while remain > 0:

                size = min(
                    CHUNK_SIZE,
                    remain
                )

                data = f.read(size)

                if not data:
                    break

                try:

                    self.wfile.write(data)
                    self.wfile.flush()

                except (
                    ConnectionAbortedError,
                    ConnectionResetError,
                    BrokenPipeError
                ):

                    return

                remain -= len(data)

    def log_message(self, format, *args):
        pass


class MediaHTTPServer(ThreadingHTTPServer):
    """
    ThreadingHTTPServer tùy chỉnh: bỏ qua các lỗi kết nối bị ngắt
    giữa chừng (client tua video, đóng tab, mất mạng, ...) thay vì
    in traceback ra console như mặc định.
    """

    daemon_threads = True

    def handle_error(self, request, client_address):

        exc_type, exc_value, _ = sys.exc_info()

        if isinstance(exc_value, (
            ConnectionAbortedError,
            ConnectionResetError,
            BrokenPipeError,
            TimeoutError,
        )):
            # Lỗi client ngắt kết nối - bỏ qua, không log
            return

        # Các lỗi khác vẫn log bình thường để dễ debug
        super().handle_error(request, client_address)


_server = None


def start(
    host=HOST,
    port=PORT
):

    global _server

    if _server:
        return

    _server = MediaHTTPServer(
        (host, port),
        MediaRequestHandler
    )

    threading.Thread(
        target=_server.serve_forever,
        daemon=True
    ).start()

    print(
        f"Media Server running: http://{host}:{port}"
    )


def stop():

    global _server

    if _server:

        _server.shutdown()

        _server.server_close()

        _server = None