"""Local stand-in for the Modal web endpoint (development and tests only).

Accepts authenticated wake-ups with the same Modal-Key/Modal-Secret headers that
Modal proxy auth uses, answers 202 immediately and processes the job in a bounded
thread pool. Run with ``pnpm worker:serve``.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
from jsonschema import ValidationError

from .pipeline import run_job
from .validation import validate

INTERNAL_API = os.environ.get("BOWR_INTERNAL_API_URL", "http://127.0.0.1:54321/functions/v1/internal")
DISPATCH_KEY = os.environ.get("WORKER_DISPATCH_KEY", "local-worker-key")
DISPATCH_SECRET = os.environ.get("WORKER_DISPATCH_SECRET", "local-only-worker-dispatch-secret-0123456789")
PORT = int(os.environ.get("BOWR_WORKER_PORT", "8765"))
HEARTBEAT_SECONDS = float(os.environ.get("BOWR_WORKER_HEARTBEAT_SECONDS", "15"))
# Development only: hold each claimed job before processing, so recovery tests can
# stop a worker mid-stage. Never set in the Modal deployment.
STAGE_DELAY_SECONDS = float(os.environ.get("BOWR_WORKER_STAGE_DELAY_SECONDS", "0"))

# The local stack's vector space is the development embedding (supabase/seed.sql).
os.environ.setdefault("BOWR_DEV_EMBEDDING", "1")

# At most two concurrent processing jobs (ARCHITECTURE section 9.2).
executor = ThreadPoolExecutor(max_workers=2)
client = httpx.Client()
log = logging.getLogger("bowr_worker")


def _process(wake: dict) -> None:
    try:
        run_job(
            wake,
            INTERNAL_API,
            client,
            heartbeat_seconds=HEARTBEAT_SECONDS,
            before_process=(lambda: time.sleep(STAGE_DELAY_SECONDS)) if STAGE_DELAY_SECONDS > 0 else None,
        )
    except Exception:
        # The durable job stays claimable after its lease; details are not logged.
        log.exception("job %s failed", wake.get("job_id"))


class WakeHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path != "/wake" or not self._authorized():
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            wake = json.loads(self.rfile.read(min(length, 4096)))
            validate("worker_wake", wake)
        except (ValueError, ValidationError):
            self.send_response(422)
            self.end_headers()
            return
        executor.submit(_process, wake)
        self.send_response(202)
        self.end_headers()

    def _authorized(self) -> bool:
        key = self.headers.get("Modal-Key", "")
        secret = self.headers.get("Modal-Secret", "")
        return hmac.compare_digest(key, DISPATCH_KEY) and hmac.compare_digest(secret, DISPATCH_SECRET)

    def log_message(self, format: str, *args: object) -> None:
        # Request lines are not logged; they carry no useful information here.
        return


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), WakeHandler)  # noqa: S104 - reachable from the local Docker network
    log.info("bowr worker listening on :%s", PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
