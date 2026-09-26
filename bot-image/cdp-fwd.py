#!/usr/bin/env python3
# Forwards the container's all-interface CDP port 9222 to Chromium's DevTools
# listener. Chromium (>= ~130) clamps its DevTools HTTP/WS server to loopback
# and ignores --remote-debugging-address, and binding its own port (9223 here) is
# the only non-conflicting way to keep the published 9222 alive; this listens on
# all interfaces on 9222 and pipes to Chromium on 127.0.0.1:9223. Plain TCP
# passthrough - confidentiality is the host-side 127.0.0.1-only publish plus the
# container's isolated Docker network (see local-wsl-host.ts and README.md).
import socket
import socketserver
import threading

TARGET = ("127.0.0.1", 9223)


class Forwarder(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            upstream = socket.create_connection(TARGET, timeout=5)
        except OSError:
            self.request.close()
            return
        try:
            threading.Thread(target=self._pump, args=(self.request, upstream), daemon=True).start()
            self._pump(upstream, self.request)
        finally:
            upstream.close()
            self.request.close()

    def _pump(self, src, dst):
        try:
            while True:
                chunk = src.recv(65536)
                if not chunk:
                    break
                dst.sendall(chunk)
        except OSError:
            pass


if __name__ == "__main__":
    Forwarder(("0.0.0.0", 9222), Handler).serve_forever()