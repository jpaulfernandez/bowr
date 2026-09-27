"""Worker job flow against a fake internal API and object store."""

from __future__ import annotations

import json
import logging

import httpx
import pytest

from bowr_worker.pipeline import run_job
from bowr_worker.validation import ContractViolation, validate

from .conftest import encode, two_tone

JOB_ID = "5e7659b9-0889-4ea4-b851-40b3e9c82b7a"
WAKE = {"job_id": JOB_ID, "claim_token": "a" * 64}
API = "http://internal.test"
SIGNED = "X-Amz-Signature=secret-signature"


def claim_body(declared: str = "image/png") -> dict:
    return {
        "data": {
            "schema_version": 1,
            "job_id": JOB_ID,
            "kind": "validate_upload",
            "lease_generation": 1,
            "lease_expires_at": "2026-09-25T10:00:00Z",
            "capability": "capability-token-for-this-job-only",
            "input": {
                "declared_content_type": declared,
                "purpose": "garment",
                "rotation": 0,
                "max_bytes": 20 * 1024 * 1024,
                "max_pixels": 40_000_000,
                "max_edge": 1024,
            },
            "source": {"url": f"http://store.test/source?{SIGNED}"},
            "output": {"url": f"http://store.test/output?{SIGNED}", "content_type": "image/webp"},
        }
    }


def fake_transport(
    source: bytes | None, calls: list[httpx.Request], claim_status: int = 200
) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/v1/jobs/claim":
            return httpx.Response(claim_status, json=claim_body() if claim_status == 200 else {"error": {}})
        if request.url.path == "/source":
            return httpx.Response(404) if source is None else httpx.Response(200, content=source)
        if request.url.path == "/output":
            return httpx.Response(200)
        if request.url.path == f"/v1/jobs/{JOB_ID}/complete":
            return httpx.Response(200, json={"data": {"status": "applied"}})
        return httpx.Response(500)

    return httpx.MockTransport(handler)


def test_valid_upload_is_written_to_the_signed_output_then_completed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    calls: list[httpx.Request] = []
    with httpx.Client(transport=fake_transport(encode(two_tone(), "PNG"), calls)) as client:
        assert run_job(WAKE, API, client) == "ready:applied"
    paths = [call.url.path for call in calls]
    assert paths == ["/v1/jobs/claim", "/source", "/output", f"/v1/jobs/{JOB_ID}/complete"]
    put = calls[2]
    assert put.method == "PUT" and put.headers["content-type"] == "image/webp"
    complete = calls[3]
    assert complete.headers["authorization"] == "Bearer capability-token-for-this-job-only"
    body = json.loads(complete.content)
    assert body["outcome"] == "ready" and body["output"]["width"] == 400
    assert SIGNED not in caplog.text


def test_rejected_upload_reports_a_failure_code_and_writes_nothing() -> None:
    calls: list[httpx.Request] = []
    with httpx.Client(transport=fake_transport(b"not an image", calls)) as client:
        assert run_job(WAKE, API, client) == "rejected:applied"
    assert "/output" not in [call.url.path for call in calls]
    assert json.loads(calls[-1].content)["failure_code"] == "UNSUPPORTED_MEDIA"


def test_missing_source_is_reported() -> None:
    calls: list[httpx.Request] = []
    with httpx.Client(transport=fake_transport(None, calls)) as client:
        run_job(WAKE, API, client)
    assert json.loads(calls[-1].content)["failure_code"] == "SOURCE_MISSING"


def test_refused_claim_does_no_work() -> None:
    calls: list[httpx.Request] = []
    with httpx.Client(transport=fake_transport(b"", calls, claim_status=403)) as client:
        assert run_job(WAKE, API, client) == "claim_refused"
    assert [call.url.path for call in calls] == ["/v1/jobs/claim"]


def lease_transport(
    calls: list[httpx.Request], heartbeat: str = "renewed", put_status: int = 200
) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        path = request.url.path
        if path == "/v1/jobs/claim":
            return httpx.Response(200, json=claim_body())
        if path == "/source":
            return httpx.Response(200, content=encode(two_tone(), "PNG"))
        if path.startswith("/output"):
            return httpx.Response(put_status)
        if path.endswith("/heartbeat"):
            if heartbeat == "renewed":
                return httpx.Response(
                    200,
                    json={
                        "data": {
                            "status": "renewed",
                            "lease_expires_at": "2026-09-25T10:02:00Z",
                            "capability": "renewed-capability-token-value",
                            "output": {
                                "url": f"http://store.test/output-renewed?{SIGNED}",
                                "content_type": "image/webp",
                            },
                        }
                    },
                )
            return httpx.Response(200, json={"data": {"status": heartbeat}})
        if path.endswith(("/complete", "/fail")):
            return httpx.Response(200, json={"data": {"status": "applied"}})
        return httpx.Response(500)

    return httpx.MockTransport(handler)


def test_heartbeats_renew_the_capability_and_output_url() -> None:
    calls: list[httpx.Request] = []
    with httpx.Client(transport=lease_transport(calls)) as client:
        outcome = run_job(
            WAKE, API, client, heartbeat_seconds=0.05, before_process=lambda: __import__("time").sleep(0.3)
        )
    assert outcome == "ready:applied"
    paths = [call.url.path for call in calls]
    assert "/output-renewed" in paths, "the renewed output URL is used"
    complete = next(call for call in calls if call.url.path.endswith("/complete"))
    assert complete.headers["authorization"] == "Bearer renewed-capability-token-value"


def test_a_refused_heartbeat_abandons_the_attempt_without_writing() -> None:
    calls: list[httpx.Request] = []
    with httpx.Client(transport=lease_transport(calls, heartbeat="stale")) as client:
        outcome = run_job(
            WAKE, API, client, heartbeat_seconds=0.05, before_process=lambda: __import__("time").sleep(0.3)
        )
    assert outcome == "lease_lost"
    paths = [call.url.path for call in calls]
    assert not any(p.startswith("/output") for p in paths)
    assert not any(p.endswith(("/complete", "/fail")) for p in paths)


def test_a_storage_failure_is_reported_as_transient() -> None:
    calls: list[httpx.Request] = []
    with httpx.Client(transport=lease_transport(calls, put_status=503)) as client:
        outcome = run_job(WAKE, API, client)
    assert outcome.startswith("failed:TRANSIENT_STORAGE")
    fail = next(call for call in calls if call.url.path.endswith("/fail"))
    assert json.loads(fail.content) == {
        "schema_version": 1,
        "lease_generation": 1,
        "failure_code": "TRANSIENT_STORAGE",
    }
    assert not any(call.url.path.endswith("/complete") for call in calls)


def test_a_contract_violation_never_carries_signed_urls_or_capabilities() -> None:
    signed_url = "http://store.test/source?X-Amz-Signature=very-secret-signature"
    claim = {
        "schema_version": 1,
        "job_id": "11111111-2222-4333-8444-555555555555",
        "kind": "validate_upload",
        "lease_generation": 1,
        "lease_expires_at": "2026-09-26T10:00:00Z",
        "capability": "capability-token-that-must-not-be-logged",
        "input": {"purpose": "not-a-purpose"},
        "source": {"url": signed_url},
        "output": {"url": signed_url, "content_type": "image/webp"},
    }
    with pytest.raises(ContractViolation) as raised:
        validate("worker_claim_response", claim)
    text = str(raised.value)
    assert text.startswith("worker_claim_response")
    assert "very-secret-signature" not in text and "capability-token" not in text
