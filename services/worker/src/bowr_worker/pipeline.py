"""One validation job: claim, fetch, normalize, upload, complete.

The worker holds no database, provider or bucket credentials. It receives a
single-use claim token, exchanges it for a job-scoped capability and exact signed
URLs, and reports a typed result. Signed URLs are never logged.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .media import MediaRejected, normalize
from .validation import validate

log = logging.getLogger("bowr_worker")
# httpx logs full request URLs at INFO; signed URLs are bearer capabilities.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


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


def run_job(wake: dict[str, Any], internal_api: str, client: httpx.Client) -> str:
    """Processes one job. Returns a short outcome label for operational logs."""
    validate("worker_wake", wake)
    claimed = client.post(f"{internal_api}/v1/jobs/claim", json=wake, timeout=30)
    if claimed.status_code != 200:
        log.info("job %s claim refused (%s)", wake["job_id"], claimed.status_code)
        return "claim_refused"
    job = claimed.json()["data"]
    validate("worker_claim_response", job)
    spec = job["input"]

    body: dict[str, Any]
    try:
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
        uploaded = client.put(
            job["output"]["url"],
            content=image.data,
            headers={"Content-Type": job["output"]["content_type"]},
            timeout=60,
        )
        uploaded.raise_for_status()
        body = {
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
    except MediaRejected as rejected:
        body = {
            "schema_version": 1,
            "lease_generation": job["lease_generation"],
            "outcome": "rejected",
            "failure_code": rejected.code,
        }

    validate("worker_complete_request", body)
    completed = client.post(
        f"{internal_api}/v1/jobs/{job['job_id']}/complete",
        json=body,
        headers={"Authorization": f"Bearer {job['capability']}"},
        timeout=30,
    )
    status = (
        completed.json().get("data", {}).get("status")
        if completed.status_code == 200
        else completed.status_code
    )
    log.info("job %s %s -> %s", job["job_id"], body["outcome"], status)
    return f"{body['outcome']}:{status}"
