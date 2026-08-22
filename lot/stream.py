from __future__ import annotations

import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler
from socketserver import TCPServer, ThreadingMixIn

from .camera import CameraError, USBCamera
from .config import ConfigError, load_settings

_BOUNDARY = "lotstreamframe"


class _FrameBuffer:
    """Latest JPEG frame, shared between the capture thread and any number of
    HTTP client threads. A Condition lets clients block until a new frame
    lands instead of polling."""

    def __init__(self) -> None:
        self._jpeg: bytes | None = None
        self._condition = threading.Condition()

    def update(self, jpeg_bytes: bytes) -> None:
        with self._condition:
            self._jpeg = jpeg_bytes
            self._condition.notify_all()

    def next_frame(self) -> bytes:
        with self._condition:
            self._condition.wait()
            assert self._jpeg is not None
            return self._jpeg

    def current(self) -> bytes | None:
        with self._condition:
            return self._jpeg


def _capture_loop(camera: USBCamera, jpeg_quality: int, buffer: _FrameBuffer, stop: threading.Event) -> None:
    try:
        for frame in camera.iter_frames():
            if stop.is_set():
                return
            buffer.update(frame.to_jpeg_bytes(jpeg_quality))
    except CameraError as exc:
        print(f"Camera error in stream loop: {exc}", file=sys.stderr)
        stop.set()


def _make_handler(buffer: _FrameBuffer):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass  # keep stdout clean; real errors are printed by the capture loop

        def do_GET(self) -> None:
            if self.path == "/stream":
                self._serve_stream()
            elif self.path == "/snapshot":
                self._serve_snapshot()
            elif self.path == "/":
                self._serve_index()
            else:
                self.send_error(404)

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")

        def _serve_stream(self) -> None:
            self.send_response(200)
            self.send_header("Cache-Control", "no-cache, private")
            self.send_header("Pragma", "no-cache")
            self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={_BOUNDARY}")
            self._cors()
            self.end_headers()
            try:
                while True:
                    jpeg = buffer.next_frame()
                    self.wfile.write(f"--{_BOUNDARY}\r\n".encode())
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Content-Length", str(len(jpeg)))
                    self.end_headers()
                    self.wfile.write(jpeg)
                    self.wfile.write(b"\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass  # client navigated away / closed the <img> tag -- not an error

        def _serve_snapshot(self) -> None:
            jpeg = buffer.current()
            if jpeg is None:
                self.send_error(503, "No frame captured yet")
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(jpeg)))
            self._cors()
            self.end_headers()
            self.wfile.write(jpeg)

        def _serve_index(self) -> None:
            html = b"<html><body style='margin:0'><img src='/stream' style='max-width:100%'></body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(html)))
            self._cors()
            self.end_headers()
            self.wfile.write(html)

    return Handler


class _ThreadingServer(ThreadingMixIn, TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def _local_ip() -> str:
    """Best-effort LAN IP for the printed URL. Doesn't actually send traffic --
    connect() on a UDP socket just makes the OS pick the outbound interface."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main(argv: list[str] | None = None) -> int:
    try:
        settings = load_settings(require_supabase=False, require_groq=False)
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 1

    try:
        camera = USBCamera(
            settings.camera_device, settings.camera_width, settings.camera_height, settings.warmup_frames
        )
        camera.open()
    except CameraError as exc:
        print(f"Camera error: {exc}", file=sys.stderr)
        return 1

    buffer = _FrameBuffer()
    stop = threading.Event()
    capture_thread = threading.Thread(
        target=_capture_loop, args=(camera, settings.jpeg_quality, buffer, stop), daemon=True
    )
    capture_thread.start()

    server = _ThreadingServer(("0.0.0.0", settings.stream_port), _make_handler(buffer))
    ip = _local_ip()
    print(f"Streaming at:  http://{ip}:{settings.stream_port}/stream")
    print(f"Preview page:  http://{ip}:{settings.stream_port}/")
    print(f"Snapshot:      http://{ip}:{settings.stream_port}/snapshot")
    print("Ctrl+C to stop.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        stop.set()
        server.server_close()
        camera.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
