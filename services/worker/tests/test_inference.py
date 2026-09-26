"""Colors, embeddings and the AI tag stage (P1.02)."""

from __future__ import annotations

import json

import httpx
import numpy as np
import pytest
from PIL import Image, ImageDraw

from bowr_worker import models
from bowr_worker.colors import dominant_colors
from bowr_worker.cutout import cutout
from bowr_worker.embedding import DEV_SPACE, embed
from bowr_worker.media import MediaRejected
from bowr_worker.pipeline import run_job
from bowr_worker.validation import validate

from .conftest import encode, garment

JOB_ID = "4f1c2b3a-6d5e-4a7b-8c9d-0e1f2a3b4c5d"


def navy_cutout() -> bytes:
    return cutout(encode(garment(), "WEBP"), "u2netp").cutout.data


def two_tone_cutout() -> bytes:
    """A transparent square with a 70% red and 30% cream garment."""
    image = Image.new("RGBA", (400, 400), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((50, 50, 350, 260), fill=(198, 47, 47, 255))
    draw.rectangle((50, 261, 350, 350), fill=(239, 230, 210, 255))
    return encode(image, "WEBP", lossless=True)


@pytest.fixture(autouse=True)
def dev_embedding(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOWR_DEV_EMBEDDING", "1")


def test_colors_come_from_foreground_pixels_with_named_swatches_and_shares() -> None:
    colors = dominant_colors(navy_cutout())
    assert colors[0]["name"] == "navy"
    assert colors[0]["proportion"] > 0.9
    assert colors == dominant_colors(navy_cutout())  # deterministic

    split = dominant_colors(two_tone_cutout())
    assert [c["name"] for c in split] == ["red", "cream"]
    assert split[0]["proportion"] == pytest.approx(0.7, abs=0.03)
    assert split[1]["proportion"] == pytest.approx(0.3, abs=0.03)
    assert all(c["hex"].startswith("#") and len(c["hex"]) == 7 for c in split)
    # The transparent background never counts as a color.
    assert sum(c["proportion"] for c in split) <= 1.0


def test_colors_need_a_foreground() -> None:
    with pytest.raises(MediaRejected) as rejected:
        dominant_colors(encode(Image.new("RGBA", (64, 64), (0, 0, 0, 0)), "WEBP"))
    assert rejected.value.code == "NO_FOREGROUND"


def test_dev_embeddings_are_finite_normalized_512_values_and_deterministic() -> None:
    vector = np.array(embed(navy_cutout(), *DEV_SPACE))
    assert vector.shape == (512,)
    assert np.all(np.isfinite(vector))
    assert np.linalg.norm(vector) == pytest.approx(1.0, abs=1e-5)
    assert embed(navy_cutout(), *DEV_SPACE) == list(vector)
    other = np.array(embed(two_tone_cutout(), *DEV_SPACE))
    assert float(vector @ other) < 0.9


def test_an_unknown_or_disabled_vector_space_is_refused_not_substituted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for space in [
        ("fashion_clip", "patrickjohncyh-v1", "clip-224"),
        ("bowr_dev_embed", "v2", "cutout-on-grey-64"),
    ]:
        with pytest.raises(models.ModelUnavailable):
            embed(navy_cutout(), *space)
    monkeypatch.delenv("BOWR_DEV_EMBEDDING")
    with pytest.raises(models.ModelUnavailable):
        embed(navy_cutout(), *DEV_SPACE)


def claim(stage: str) -> dict:
    base = {
        "schema_version": 1,
        "job_id": JOB_ID,
        "kind": "item_stage",
        "stage": stage,
        "lease_generation": 1,
        "lease_expires_at": "2026-09-26T10:00:00Z",
        "capability": "capability-token-for-this-job-only",
        "outputs": {},
    }
    if stage == "colors":
        return {
            **base,
            "input": {"max_colors": 5, "max_bytes": 1 << 20},
            "sources": {"cutout": {"url": "http://store.test/cutout"}},
        }
    if stage == "embedding":
        return {
            **base,
            "input": {
                "model": DEV_SPACE[0],
                "model_revision": DEV_SPACE[1],
                "preprocess_version": DEV_SPACE[2],
                "dimension": 512,
                "max_bytes": 1 << 20,
            },
            "sources": {"cutout": {"url": "http://store.test/cutout"}},
        }
    if stage == "label":
        return {**base, "input": {"task": "label_read"}, "sources": {}}
    return {**base, "input": {"task": "item_tags"}, "sources": {}}


def transport(stage: str, calls: list[httpx.Request]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/v1/jobs/claim":
            return httpx.Response(200, json={"data": claim(stage)})
        if request.url.path == "/cutout":
            return httpx.Response(200, content=navy_cutout())
        if request.url.path == f"/v1/jobs/{JOB_ID}/complete":
            return httpx.Response(200, json={"data": {"status": "applied"}})
        if request.url.path == f"/v1/jobs/{JOB_ID}/ai":
            return httpx.Response(200, json={"data": {"status": "blocked"}})
        return httpx.Response(500)

    return httpx.MockTransport(handler)


@pytest.mark.parametrize("stage", ["colors", "embedding"])
def test_local_stages_download_the_cutout_and_complete_with_a_valid_result(stage: str) -> None:
    validate("worker_claim_response", claim(stage))
    calls: list[httpx.Request] = []
    with httpx.Client(transport=transport(stage, calls)) as client:
        assert (
            run_job({"job_id": JOB_ID, "claim_token": "c" * 64}, "http://internal.test", client)
            == "ready:applied"
        )
    assert [c.url.path for c in calls] == ["/v1/jobs/claim", "/cutout", f"/v1/jobs/{JOB_ID}/complete"]
    body = json.loads(calls[-1].content)
    validate("item_stage_complete_request", body)
    if stage == "embedding":
        assert len(body["result"]["vector"]) == 512 and body["result"]["model"] == DEV_SPACE[0]
    else:
        assert body["result"]["suggested"]["colors"][0]["name"] == "navy"


@pytest.mark.parametrize("stage", ["tags", "label"])
def test_ai_stages_only_ask_the_gateway_to_run_them_and_never_complete_themselves(stage: str) -> None:
    validate("worker_claim_response", claim(stage))
    calls: list[httpx.Request] = []
    with httpx.Client(transport=transport(stage, calls)) as client:
        assert (
            run_job({"job_id": JOB_ID, "claim_token": "c" * 64}, "http://internal.test", client)
            == "ai:blocked"
        )
    assert [c.url.path for c in calls] == ["/v1/jobs/claim", f"/v1/jobs/{JOB_ID}/ai"]
    assert json.loads(calls[1].content) == {"schema_version": 1, "lease_generation": 1}
    assert calls[1].headers["authorization"] == "Bearer capability-token-for-this-job-only"
