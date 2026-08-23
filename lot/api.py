from __future__ import annotations

import json
import socket
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from socketserver import TCPServer, ThreadingMixIn
from urllib.parse import parse_qs, urlparse

from .camera import CameraError
from .capture import capture_and_publish
from .config import ConfigError, Settings, load_settings
from .grader import GraderError

# How long a request will wait for exclusive camera access before giving up.
# Generous: a real capture (warm-up + grade + upload) normally finishes in a
# few seconds, so this only bites if something upstream is genuinely stuck.
_CAMERA_LOCK_TIMEOUT = 30.0


def _json_body(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    if length == 0:
        return {}
    raw = handler.rfile.read(length)
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _make_handler(settings: Settings, camera_lock: threading.Lock):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass  # keep stdout clean; real errors are printed explicitly below

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-Key")

        def _send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            if not settings.api_key:
                return True  # no key configured: auth disabled (LAN-only use)
            return self.headers.get("X-API-Key") == settings.api_key

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self) -> None:
            if urlparse(self.path).path == "/health":
                self._send_json(200, {"ok": True})
            else:
                self._send_json(404, {"ok": False, "error": "not found"})

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path != "/capture":
                self._send_json(404, {"ok": False, "error": "not found"})
                return

            if not self._authorized():
                self._send_json(401, {"ok": False, "error": "missing or invalid X-API-Key"})
                return

            query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            body = _json_body(self)
            params = {**query, **body}

            dry_run = str(params.get("dry_run", "")).lower() in ("1", "true", "yes")
            item_id = params.get("item_id")
            if not item_id and not dry_run:
                self._send_json(400, {"ok": False, "error": "item_id is required unless dry_run is set"})
                return
            if not item_id:
                item_id = "DRYRUN-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")

            if not camera_lock.acquire(timeout=_CAMERA_LOCK_TIMEOUT):
                self._send_json(503, {"ok": False, "error": "camera busy, timed out waiting for it"})
                return
            try:
                result = capture_and_publish(settings, item_id, dry_run=dry_run)
            except CameraError as exc:
                self._send_json(500, {"ok": False, "error": f"camera error: {exc}"})
                return
            except GraderError as exc:
                self._send_json(500, {"ok": False, "error": f"grading error: {exc}"})
                return
            finally:
                camera_lock.release()

            payload = {"ok": True, **result.to_dict()}
            status = 202 if result.queued else 200
            self._send_json(status, payload)

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
        settings = load_settings(require_supabase=True, require_groq=True)
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 1

    camera_lock = threading.Lock()
    server = _ThreadingServer(("0.0.0.0", settings.api_port), _make_handler(settings, camera_lock))
    ip = _local_ip()
    print(f"Capture API at: http://{ip}:{settings.api_port}/capture  (POST, ?item_id=LOT-001)")
    print(f"Health check:   http://{ip}:{settings.api_port}/health")
    if settings.api_key:
        print("Auth: X-API-Key header required.")
    else:
        print("Auth: none (LOT_API_KEY not set) -- keep this off the public internet.")
    print("Note: needs exclusive access to the camera device -- don't run this")
    print("alongside lot.stream or lot.capture against the same /dev/video*.")
    print("Ctrl+C to stop.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

