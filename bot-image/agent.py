#!/usr/bin/env python3
"""Deskmates bot PC agent.

A small HTTP control service for one bot's Linux PC: screenshots, input, files and commands,
plus a health check. Standard library only — nothing here is `pip install`ed.

Listens on 0.0.0.0:8700 by default (see HOST/PORT below) — every interface *inside the
container*, not the host. Docker's `-p 127.0.0.1:<host>:8700` publishing (see
`LocalWslHost.runContainer` in src/core/bots/local-wsl-host.ts) delivers inbound host
connections to the container's own bridge-facing address, never to its loopback, so a
service bound only to 127.0.0.1 in here would be unreachable from the host too - binding
0.0.0.0 is what makes the host-side 127.0.0.1 restriction actually take effect. The
security boundary this depends on isn't this bind address; it's that (a) the host only
ever publishes this port on 127.0.0.1, and (b) each bot's container sits on its own
isolated Docker network with nothing else attached, so no other bot's container can
reach it either - see `local-wsl-host.ts`'s per-bot `docker network create`/`--network`
and bot-image/README.md's Security section. Every request must carry an X-Deskmates-Token
header equal to the DESKMATES_TOKEN environment variable — the same variable
`LocalWslHost.runContainer` sets with `docker run -e DESKMATES_TOKEN=...`. A request
without a valid token gets 401 and is never logged with its header values.

Endpoints:
  GET  /health            -> versions, and whether X, Chromium and VNC are up
  GET  /screenshot        -> PNG of the current root window
  POST /input             -> {action: move|click|double_click|type|key|scroll, ...} via xdotool
  POST /exec              -> {command: [...], timeoutMs?} runs an argument list, never a shell string
  GET  /files?path=...    -> raw bytes of a file under data/ or shared/
  PUT  /files?path=...    -> writes the request body to a file under data/ or shared/
  GET  /windows           -> open windows, from xdotool

`path` values for /files must start with "data/" or "shared/" and are resolved to real,
symlink-free paths before use; anything that would land outside /home/bot/data or /shared
(a `..` segment, an absolute path, or a symlink that leads outside) is rejected with 400.
"""

from __future__ import annotations

import hmac
import json
import mimetypes
import os
import platform
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

AGENT_VERSION = "0.1.0"

# 0.0.0.0, not 127.0.0.1: Docker delivers a published port's traffic to the container's bridge
# interface, not its loopback, so binding loopback-only here would make the agent unreachable
# even through the host's own 127.0.0.1-published port. Reachability is fenced by the *host-side*
# publish (always 127.0.0.1) and by this container's own isolated Docker network, not by this bind
# address - see the module docstring above and bot-image/README.md's Security section.
HOST = "0.0.0.0"
PORT = int(os.environ.get("DESKMATES_AGENT_PORT", "8700"))
TOKEN_HEADER = "X-Deskmates-Token"
TOKEN_ENV_VAR = "DESKMATES_TOKEN"  # matches local-wsl-host.ts's `docker run -e DESKMATES_TOKEN=...`

DISPLAY = os.environ.get("DISPLAY", ":0")
VNC_PORT = int(os.environ.get("DESKMATES_VNC_PORT", "5900"))
CDP_PORT = int(os.environ.get("DESKMATES_CDP_PORT", "9222"))

# Bind-mounted in production (see local-wsl-host.ts: `-v <pcStorageDir>:/home/bot/data`,
# `-v <sharedDir>:/shared`); overridable so tests can point them at temp directories instead.
DATA_ROOT = Path(os.environ.get("DESKMATES_DATA_DIR", "/home/bot/data")).resolve()
SHARED_ROOT = Path(os.environ.get("DESKMATES_SHARED_DIR", "/shared")).resolve()

MAX_EXEC_OUTPUT = 100 * 1024  # 100 KB cap, applied separately to stdout and stderr
DEFAULT_EXEC_TIMEOUT_MS = 30_000


class AgentError(Exception):
    """A request-level failure: `status` plus a plain-sentence `message`, never a stack trace."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class Response:
    __slots__ = ("status", "content_type", "body", "headers")

    def __init__(self, status: int, content_type: str, body: bytes, headers: dict[str, str] | None = None) -> None:
        self.status = status
        self.content_type = content_type
        self.body = body
        self.headers = headers or {}


def json_response(status: int, obj: object) -> Response:
    return Response(status, "application/json", json.dumps(obj).encode("utf-8"))


# ---- auth ----


def check_token(headers) -> None:
    expected = os.environ.get(TOKEN_ENV_VAR, "")
    provided = headers.get(TOKEN_HEADER, "")
    # An unset/empty token must fail every request rather than accept anything - comparing two
    # empty strings with compare_digest would otherwise return True.
    if not expected or not hmac.compare_digest(provided, expected):
        raise AgentError(401, "missing or invalid token")


# ---- path safety (for /files) ----


def resolve_safe_path(raw: str) -> Path:
    """Resolves a `path` query value to a real path inside DATA_ROOT or SHARED_ROOT.

    Only "data/..." or "shared/..." is accepted. Every segment is checked for ".." before any
    filesystem access, and the final candidate is fully resolved (symlinks included) and then
    re-checked against the chosen root, so a symlink that leads outside can't be used to escape
    either root.
    """
    if not raw:
        raise AgentError(400, "path is required")
    if "\x00" in raw or "\\" in raw:
        raise AgentError(400, "invalid path")

    parts = raw.split("/")
    if parts[0] == "data":
        root = DATA_ROOT
    elif parts[0] == "shared":
        root = SHARED_ROOT
    else:
        raise AgentError(400, "path must start with 'data/' or 'shared/'")

    segments = parts[1:]
    if not segments or any(seg in ("", ".", "..") for seg in segments):
        raise AgentError(400, "invalid path")

    candidate = root
    for segment in segments:
        candidate = candidate / segment

    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError:
        raise AgentError(400, "path escapes the allowed folder") from None
    return resolved


# ---- xdotool ----


def _xdotool_path() -> str:
    # shutil.which() checks PATHEXT on Windows (needed for the fake .cmd xdotool the tests use)
    # and behaves like a normal PATH search on POSIX (where the real xdotool lives in production).
    return shutil.which("xdotool") or "xdotool"


def _run_xdotool(argv: list[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(argv, capture_output=True, timeout=10)
    except FileNotFoundError:
        raise AgentError(503, "xdotool is not available") from None
    except subprocess.TimeoutExpired:
        raise AgentError(504, "xdotool timed out") from None


def _require_xy(body: dict) -> tuple[int, int]:
    x, y = body.get("x"), body.get("y")
    if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        raise AgentError(400, "x and y must be numbers")
    return int(x), int(y)


def _button(body: dict) -> int:
    button = body.get("button", 1)
    if isinstance(button, bool) or not isinstance(button, int) or button < 1 or button > 9:
        raise AgentError(400, "button must be an integer from 1 to 9")
    return button


def handle_input(body: dict) -> Response:
    action = body.get("action")
    xdotool = _xdotool_path()
    has_xy = "x" in body or "y" in body

    if action == "move":
        x, y = _require_xy(body)
        argv = [xdotool, "mousemove", "--sync", str(x), str(y)]
    elif action in ("click", "double_click"):
        button = _button(body)
        argv = [xdotool]
        if has_xy:
            x, y = _require_xy(body)
            argv += ["mousemove", "--sync", str(x), str(y)]
        if action == "click":
            argv += ["click", str(button)]
        else:
            argv += ["click", "--repeat", "2", "--delay", "100", str(button)]
    elif action == "type":
        text = body.get("text")
        if not isinstance(text, str) or text == "":
            raise AgentError(400, "text is required")
        argv = [xdotool, "type", "--clearmodifiers", "--", text]
    elif action == "key":
        keys = body.get("keys")
        if not isinstance(keys, str) or keys == "":
            raise AgentError(400, "keys is required")
        argv = [xdotool, "key", "--clearmodifiers", "--", keys]
    elif action == "scroll":
        direction = body.get("direction")
        scroll_button = {"up": "4", "down": "5", "left": "6", "right": "7"}.get(direction)
        if scroll_button is None:
            raise AgentError(400, "direction must be up, down, left or right")
        amount = body.get("amount", 1)
        if isinstance(amount, bool) or not isinstance(amount, int) or amount < 1:
            raise AgentError(400, "amount must be a positive integer")
        argv = [xdotool]
        if has_xy:
            x, y = _require_xy(body)
            argv += ["mousemove", "--sync", str(x), str(y)]
        argv += ["click", "--repeat", str(amount), scroll_button]
    else:
        raise AgentError(400, f"unknown input action '{action}'")

    proc = _run_xdotool(argv)
    if proc.returncode != 0:
        raise AgentError(500, f"xdotool failed: {proc.stderr.decode('utf-8', 'replace').strip()}")
    return json_response(200, {"ok": True})


def _xdotool_query(xdotool: str, args: list[str]) -> str:
    try:
        proc = subprocess.run([xdotool, *args], capture_output=True, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""
    if proc.returncode != 0:
        return ""
    return proc.stdout.decode("utf-8", "replace").strip()


def _xdotool_geometry(xdotool: str, window_id: str) -> dict:
    text = _xdotool_query(xdotool, ["getwindowgeometry", "--shell", window_id])
    values: dict[str, str] = {}
    for line in text.splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip()

    def as_int(key: str) -> int:
        try:
            return int(values.get(key, "0"))
        except ValueError:
            return 0

    return {"x": as_int("X"), "y": as_int("Y"), "width": as_int("WIDTH"), "height": as_int("HEIGHT")}


def handle_windows() -> Response:
    xdotool = _xdotool_path()
    proc = _run_xdotool([xdotool, "search", "--onlyvisible", "--name", ".*"])
    # xdotool search exits 1 when nothing matches - that's an empty desktop, not a failure.
    if proc.returncode not in (0, 1):
        raise AgentError(500, f"xdotool search failed: {proc.stderr.decode('utf-8', 'replace').strip()}")
    ids = [line.strip() for line in proc.stdout.decode("utf-8", "replace").splitlines() if line.strip()]

    windows = []
    for window_id in ids:
        name = _xdotool_query(xdotool, ["getwindowname", window_id])
        geometry = _xdotool_geometry(xdotool, window_id)
        windows.append({"id": window_id, "name": name, **geometry})
    return json_response(200, {"windows": windows})


# ---- screenshot (xwd -> hand-rolled PNG encoder, no extra image library) ----


def capture_screenshot() -> bytes:
    xwd = shutil.which("xwd") or "xwd"
    try:
        proc = subprocess.run([xwd, "-root", "-silent", "-display", DISPLAY], capture_output=True, timeout=10)
    except FileNotFoundError:
        raise AgentError(503, "xwd is not available") from None
    except subprocess.TimeoutExpired:
        raise AgentError(504, "xwd timed out") from None
    if proc.returncode != 0 or not proc.stdout:
        detail = proc.stderr.decode("utf-8", "replace").strip() or f"exit code {proc.returncode}"
        raise AgentError(503, f"couldn't capture the screen: {detail}")
    try:
        return xwd_to_png(proc.stdout)
    except ValueError as exc:
        raise AgentError(500, f"couldn't decode the captured screen: {exc}") from None


def xwd_to_png(data: bytes) -> bytes:
    """Converts one `xwd -root` capture (X Window Dump, ZPixmap, 24/32bpp TrueColor) to PNG bytes."""
    if len(data) < 100:
        raise ValueError("truncated XWD data")

    (
        header_size,
        file_version,
        pixmap_format,
        _pixmap_depth,
        pixmap_width,
        pixmap_height,
        _xoffset,
        byte_order,
        _bitmap_unit,
        _bitmap_bit_order,
        _bitmap_pad,
        bits_per_pixel,
        bytes_per_line,
        _visual_class,
        red_mask,
        green_mask,
        blue_mask,
        _bits_per_rgb,
        _colormap_entries,
        ncolors,
        _window_width,
        _window_height,
        _window_x,
        _window_y,
        _window_bdrwidth,
    ) = struct.unpack(">25I", data[:100])

    if file_version != 7:
        raise ValueError(f"unsupported XWD file version {file_version}")
    if pixmap_format != 2:  # 2 = ZPixmap
        raise ValueError("only ZPixmap captures are supported")
    if pixmap_width <= 0 or pixmap_height <= 0:
        raise ValueError("empty screenshot")
    if bits_per_pixel not in (24, 32):
        raise ValueError(f"unsupported bits-per-pixel {bits_per_pixel}")

    offset = header_size + ncolors * 12  # header_size already includes the null-terminated window name
    pixel_bytes = bytes_per_line * pixmap_height
    if offset + pixel_bytes > len(data):
        raise ValueError("truncated pixel data")
    pixels = data[offset : offset + pixel_bytes]

    bpp = bits_per_pixel // 8

    def byte_offset(mask: int) -> int:
        if mask == 0:
            raise ValueError("unsupported color mask")
        shift = 0
        while not (mask >> shift) & 1:
            shift += 1
        byte_index = shift // 8
        return bpp - 1 - byte_index if byte_order == 1 else byte_index  # 1 = MSBFirst

    red_off = byte_offset(red_mask)
    green_off = byte_offset(green_mask)
    blue_off = byte_offset(blue_mask)

    rows = []
    row_width_bytes = pixmap_width * bpp
    for y in range(pixmap_height):
        start = y * bytes_per_line
        row = pixels[start : start + row_width_bytes]
        interleaved = bytearray(pixmap_width * 3)
        interleaved[0::3] = row[red_off::bpp][:pixmap_width]
        interleaved[1::3] = row[green_off::bpp][:pixmap_width]
        interleaved[2::3] = row[blue_off::bpp][:pixmap_width]
        rows.append(bytes(interleaved))

    return encode_png(pixmap_width, pixmap_height, b"".join(rows))


_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _png_chunk(tag: bytes, chunk_data: bytes) -> bytes:
    return struct.pack(">I", len(chunk_data)) + tag + chunk_data + struct.pack(">I", zlib.crc32(tag + chunk_data) & 0xFFFFFFFF)


def encode_png(width: int, height: int, rgb: bytes) -> bytes:
    """Encodes raw, top-to-bottom, unpadded RGB24 pixel data as a PNG (8-bit depth, no interlacing)."""
    if len(rgb) != width * height * 3:
        raise ValueError("pixel buffer size mismatch")
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # color type 2 = truecolor RGB
    stride = width * 3
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 = None, per scanline
        raw += rgb[y * stride : (y + 1) * stride]
    idat = zlib.compress(bytes(raw), 6)
    return _PNG_SIGNATURE + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IDAT", idat) + _png_chunk(b"IEND", b"")


# ---- exec ----


def _cap(data: bytes) -> tuple[str, bool]:
    truncated = len(data) > MAX_EXEC_OUTPUT
    if truncated:
        data = data[:MAX_EXEC_OUTPUT]
    return data.decode("utf-8", "replace"), truncated


def handle_exec(body: dict) -> Response:
    command = body.get("command")
    if not isinstance(command, list) or not command or not all(isinstance(part, str) for part in command):
        raise AgentError(400, "command must be a non-empty array of strings")
    timeout_ms = body.get("timeoutMs", DEFAULT_EXEC_TIMEOUT_MS)
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, (int, float)) or timeout_ms <= 0:
        raise AgentError(400, "timeoutMs must be a positive number")

    try:
        proc = subprocess.run(command, capture_output=True, timeout=timeout_ms / 1000)
    except FileNotFoundError as exc:
        raise AgentError(400, f"command not found: {exc.filename or command[0]}") from None
    except subprocess.TimeoutExpired:
        return json_response(
            200, {"code": None, "timedOut": True, "stdout": "", "stdoutTruncated": False, "stderr": "", "stderrTruncated": False}
        )

    stdout, stdout_truncated = _cap(proc.stdout)
    stderr, stderr_truncated = _cap(proc.stderr)
    return json_response(
        200,
        {
            "code": proc.returncode,
            "timedOut": False,
            "stdout": stdout,
            "stdoutTruncated": stdout_truncated,
            "stderr": stderr,
            "stderrTruncated": stderr_truncated,
        },
    )


# ---- files ----


def _single(query: dict, name: str) -> str:
    values = query.get(name)
    if not values or not values[0]:
        raise AgentError(400, f"{name} is required")
    return values[0]


def handle_files_get(query: dict) -> Response:
    path = resolve_safe_path(_single(query, "path"))
    if not path.is_file():
        raise AgentError(404, "file not found")
    content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    return Response(200, content_type, path.read_bytes())


def handle_files_put(query: dict, body: bytes) -> Response:
    path = resolve_safe_path(_single(query, "path"))
    if path.is_dir():
        raise AgentError(400, "path is a directory")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return json_response(200, {"ok": True, "bytes": len(body)})


# ---- health ----


def _tcp_open(host: str, port: int, timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _chromium_status() -> tuple[bool, str | None]:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/version", timeout=0.5) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            return True, payload.get("Browser")
    except Exception:
        return False, None


def handle_health() -> Response:
    display_num = DISPLAY.lstrip(":").split(".")[0] or "0"
    x_up = Path(f"/tmp/.X11-unix/X{display_num}").exists()
    vnc_up = _tcp_open("127.0.0.1", VNC_PORT)
    chromium_up, chromium_version = _chromium_status()
    return json_response(
        200,
        {
            "status": "ok",
            "agentVersion": AGENT_VERSION,
            "pythonVersion": platform.python_version(),
            "display": DISPLAY,
            "x": x_up,
            "vnc": vnc_up,
            "chromium": chromium_up,
            "chromiumVersion": chromium_version,
        },
    )


# ---- HTTP plumbing ----


def _parse_json(body: bytes) -> dict:
    if not body:
        return {}
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise AgentError(400, "invalid JSON body") from None
    if not isinstance(parsed, dict):
        raise AgentError(400, "request body must be a JSON object")
    return parsed


class Handler(BaseHTTPRequestHandler):
    server_version = f"DeskmatesAgent/{AGENT_VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args) -> None:
        # Overridden only to keep full control of what reaches the log; this line never includes
        # headers, so the token can't end up here even though the request line (path + query) can.
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

    def _dispatch(self, method: str) -> None:
        body = b""
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            if length > 0:
                body = self.rfile.read(length)
            check_token(self.headers)
            split = urlsplit(self.path)
            query = parse_qs(split.query)
            response = self._route(method, split.path, query, body)
        except AgentError as exc:
            response = json_response(exc.status, {"error": exc.message})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:  # last line of defense: never leak a stack trace to the client
            sys.stderr.write(f"unhandled error: {exc!r}\n")
            response = json_response(500, {"error": "internal error"})
        self._send(response)

    def _route(self, method: str, path: str, query: dict, body: bytes) -> Response:
        if method == "GET" and path == "/health":
            return handle_health()
        if method == "GET" and path == "/screenshot":
            return Response(200, "image/png", capture_screenshot())
        if method == "POST" and path == "/input":
            return handle_input(_parse_json(body))
        if method == "POST" and path == "/exec":
            return handle_exec(_parse_json(body))
        if method == "GET" and path == "/files":
            return handle_files_get(query)
        if method == "PUT" and path == "/files":
            return handle_files_put(query, body)
        if method == "GET" and path == "/windows":
            return handle_windows()
        raise AgentError(404, "not found")

    def _send(self, response: Response) -> None:
        self.send_response(response.status)
        self.send_header("Content-Type", response.content_type)
        self.send_header("Content-Length", str(len(response.body)))
        for key, value in response.headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(response.body)

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")


def main() -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    SHARED_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"deskmates agent listening on http://{HOST}:{PORT}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
