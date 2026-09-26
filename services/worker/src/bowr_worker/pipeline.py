"""One job: claim, fetch, compute, upload, complete.

Validation normalizes an upload into a sanitized original; an item stage
(cutout) derives renditions from that original.

The worker holds no database, provider or bucket credentials. It receives a
single-use claim token, exchanges it for a job-scoped capability and exact signed
URLs, keeps its lease alive with heartbeats, and reports a typed result. Signed
URLs are never logged.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Any

import httpx

from . import models
from .colors import dominant_colors
from .cutout import cutout
from .embedding import embed
from .media import MediaRejected, normalize
from .validation import validate

log = logging.getLogger("bowr_worker")
# httpx logs full request URLs at INFO; signed URLs are bearer capabilities.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

HEARTBEAT_SECONDS = 15.0


class Lease:
    """Renews the job lease in the background (ARCHITECTURE section 9.2).

    A refused renewal (stale lease or stage deadline) marks the lease lost; the
    job is then abandoned without uploading or completing, because a newer attempt
    may own it.
    """

    def __init__(self, job: dict[str, Any], internal_api: str, client: httpx.Client, interval: float) -> None:
        self.job_id: str = job["job_id"]
        self.generation: int = job["lease_generation"]
        self.capability: str = job["capability"]
        # Validation writes one output; an item stage writes several.
        self.output_urls: dict[str, str] = (
            {"original": job["output"]["url"]}
            if "output" in job
            else {name: out["url"] for name, out in job["outputs"].items()}
        )
        self.lost = threading.Event()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._api = internal_api
        self._client = client
        self._interval = interval
        self._thread = threading.Thread(target=self._run, name=f"heartbeat-{self.job_id}", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def auth(self) -> dict[str, str]:
        with self._lock:
            return {"Authorization": f"Bearer {self.capability}"}

    def output_url(self, name: str) -> str:
        with self._lock:
            return self.output_urls[name]

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            body = {"schema_version": 1, "lease_generation": self.generation}
            validate("worker_heartbeat_request", body)
            try:
                response = self._client.post(
                    f"{self._api}/v1/jobs/{self.job_id}/heartbeat", json=body, headers=self.auth(), timeout=10
                )
                data = response.json()["data"] if response.status_code == 200 else {"status": "stale"}
                validate("worker_heartbeat_response", data)
            except (httpx.HTTPError, ValueError, KeyError):
                # A missed heartbeat is retried; the lease survives until its expiry.
                continue
            if data["status"] != "renewed":
                log.info("job %s lease %s", self.job_id, data["status"])
                self.lost.set()
                return
            with self._lock:
                self.capability = data["capability"]
                if "output" in data:
                    self.output_urls = {"original": data["output"]["url"]}
                else:
                    self.output_urls = {name: out["url"] for name, out in data.get("outputs", {}).items()}


def _download(client: httpx.Client, url: str, max_bytes: int) -> bytes | None:
    with client.stream("GET", url, timeout=60) as response:
        if response.status_code == 404:
            return None
        response.raise_for_status()
        chunks: list[bytes] = []
        size = 0
        for chunk in response.iter_bytes():
            size += len(chunk)
            if size > max_bytes:
                raise MediaRejected("FILE_TOO_LARGE")
            chunks.append(chunk)
        return b"".join(chunks)


def _report_failure(client: httpx.Client, internal_api: str, lease: Lease, code: str) -> str:
    body = {"schema_version": 1, "lease_generation": lease.generation, "failure_code": code}
    validate("worker_fail_request", body)
    try:
        response = client.post(
            f"{internal_api}/v1/jobs/{lease.job_id}/fail", json=body, headers=lease.auth(), timeout=30
        )
        status = (
            response.json().get("data", {}).get("status")
            if response.status_code == 200
            else response.status_code
        )
    except (httpx.HTTPError, ValueError):
        # If the report is lost, the lease expires and reconciliation retries the job.
        status = "unreported"
    log.info("job %s attempt failed (%s) -> %s", lease.job_id, code, status)
    return f"failed:{code}:{status}"


def _validate_upload(job: dict[str, Any], lease: Lease, client: httpx.Client) -> dict[str, Any] | None:
    spec = job["input"]
    source = _download(client, job["source"]["url"], spec["max_bytes"] + 1)
    if source is None:
        raise MediaRejected("SOURCE_MISSING")
    image = normalize(
        source,
        declared_content_type=spec["declared_content_type"],
        rotation=spec["rotation"],
        max_bytes=spec["max_bytes"],
        max_pixels=spec["max_pixels"],
        max_edge=spec["max_edge"],
    )
    if lease.lost.is_set():
        return None
    uploaded = client.put(
        lease.output_url("original"),
        content=image.data,
        headers={"Content-Type": job["output"]["content_type"]},
        timeout=60,
    )
    uploaded.raise_for_status()
    return {
        "schema_version": 1,
        "lease_generation": job["lease_generation"],
        "outcome": "ready",
        "output": {
            "width": image.width,
            "height": image.height,
            "byte_size": len(image.data),
            "sha256": image.sha256,
        },
    }


def _cutout_stage(job: dict[str, Any], lease: Lease, client: httpx.Client) -> dict[str, Any] | None:
    spec = job["input"]
    source = _download(client, job["sources"]["original"]["url"], spec["max_bytes"])
    if source is None:
        raise MediaRejected("SOURCE_MISSING")
    try:
        result = cutout(source, spec["model"])
    except models.ModelUnavailable as missing:
        raise MediaRejected("MODEL_UNAVAILABLE") from missing
    if lease.lost.is_set():
        return None
    renditions = {"cutout": result.cutout, "thumbnail": result.thumbnail, "mask": result.mask}
    for name, rendition in renditions.items():
        uploaded = client.put(
            lease.output_url(name),
            content=rendition.data,
            headers={"Content-Type": job["outputs"][name]["content_type"]},
            timeout=60,
        )
        uploaded.raise_for_status()
    return {
        "schema_version": 1,
        "lease_generation": job["lease_generation"],
        "outcome": "ready",
        "outputs": {name: rendition.describe() for name, rendition in renditions.items()},
        "result": {"foreground_ratio": result.foreground_ratio},
    }


def _colors_stage(job: dict[str, Any], lease: Lease, client: httpx.Client) -> dict[str, Any] | None:
    source = _download(client, job["sources"]["cutout"]["url"], job["input"]["max_bytes"])
    if source is None:
        raise MediaRejected("SOURCE_MISSING")
    colors = dominant_colors(source, job["input"]["max_colors"])
    if not colors:
        raise MediaRejected("NO_FOREGROUND")
    return {
        "schema_version": 1,
        "lease_generation": job["lease_generation"],
        "outcome": "ready",
        "result": {"suggested": {"colors": colors}},
    }


def _embedding_stage(job: dict[str, Any], lease: Lease, client: httpx.Client) -> dict[str, Any] | None:
    spec = job["input"]
    source = _download(client, job["sources"]["cutout"]["url"], spec["max_bytes"])
    if source is None:
        raise MediaRejected("SOURCE_MISSING")
    try:
        vector = embed(source, spec["model"], spec["model_revision"], spec["preprocess_version"])
    except models.ModelUnavailable as missing:
        raise MediaRejected("MODEL_UNAVAILABLE") from missing
    return {
        "schema_version": 1,
        "lease_generation": job["lease_generation"],
        "outcome": "ready",
        "result": {
            "model": spec["model"],
            "model_revision": spec["model_revision"],
            "preprocess_version": spec["preprocess_version"],
            "vector": vector,
        },
    }


STAGES = {"cutout": _cutout_stage, "colors": _colors_stage, "embedding": _embedding_stage}


def _run_ai_stage(job: dict[str, Any], lease: Lease, client: httpx.Client, internal_api: str) -> str:
    """Asks the internal gateway to run this claimed AI job. The gateway builds the
    prompt, reserves budget, calls the provider, validates and applies the result;
    the worker holds only the lease."""
    body = {"schema_version": 1, "lease_generation": job["lease_generation"]}
    validate("worker_ai_request", body)
    try:
        response = client.post(
            f"{internal_api}/v1/jobs/{job['job_id']}/ai", json=body, headers=lease.auth(), timeout=90
        )
    except httpx.HTTPError:
        return _report_failure(client, internal_api, lease, "TRANSIENT_STORAGE")
    finally:
        lease.stop()
    if response.status_code != 200:
        log.info("job %s ai request refused (%s)", job["job_id"], response.status_code)
        return f"ai:{response.status_code}"
    data = response.json()["data"]
    validate("worker_ai_response", data)
    log.info("job %s ai -> %s", job["job_id"], data["status"])
    return f"ai:{data['status']}"


def run_job(
    wake: dict[str, Any],
    internal_api: str,
    client: httpx.Client,
    *,
    heartbeat_seconds: float = HEARTBEAT_SECONDS,
    before_process: Callable[[], None] | None = None,
) -> str:
    """Processes one job. Returns a short outcome label for operational logs."""
    validate("worker_wake", wake)
    claimed = client.post(f"{internal_api}/v1/jobs/claim", json=wake, timeout=30)
    if claimed.status_code != 200:
        log.info("job %s claim refused (%s)", wake["job_id"], claimed.status_code)
        return "claim_refused"
    job = claimed.json()["data"]
    validate("worker_claim_response", job)
    item_stage = job["kind"] == "item_stage"
    complete_schema = "item_stage_complete_request" if item_stage else "worker_complete_request"

    lease = Lease(job, internal_api, client, heartbeat_seconds)
    lease.start()
    if item_stage and job["stage"] in ("tags", "label"):
        return _run_ai_stage(job, lease, client, internal_api)
    body: dict[str, Any] | None
    try:
        if before_process:
            before_process()
        body = (
            STAGES[job["stage"]](job, lease, client) if item_stage else _validate_upload(job, lease, client)
        )
        if body is None:
            return "lease_lost"
    except MediaRejected as rejected:
        body = {
            "schema_version": 1,
            "lease_generation": job["lease_generation"],
            "outcome": "rejected",
            "failure_code": rejected.code,
        }
    except httpx.HTTPError:
        return _report_failure(client, internal_api, lease, "TRANSIENT_STORAGE")
    except Exception:
        log.exception("job %s worker error", lease.job_id)
        return _report_failure(client, internal_api, lease, "WORKER_ERROR")
    finally:
        lease.stop()

    if lease.lost.is_set():
        return "lease_lost"
    validate(complete_schema, body)
    completed = client.post(
        f"{internal_api}/v1/jobs/{job['job_id']}/complete", json=body, headers=lease.auth(), timeout=30
    )
    status = (
        completed.json().get("data", {}).get("status")
        if completed.status_code == 200
        else completed.status_code
    )
    log.info("job %s %s -> %s", job["job_id"], body["outcome"], status)
    return f"{body['outcome']}:{status}"
