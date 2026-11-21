"""GET /api/health: the deployment is up."""

import json
import os
from http.server import BaseHTTPRequestHandler


def status() -> dict[str, object]:
    """What the health route answers."""
    return {"ok": True, "env": os.environ.get("APP_ENV", "local")}


class handler(BaseHTTPRequestHandler):  # noqa: N801 - Vercel looks for `handler`
    def do_GET(self) -> None:  # noqa: N802 - the http.server API
        body = json.dumps(status()).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
