"""Modal deployment of the bowr worker (staging/production).

Deploy with ``uv run --extra modal modal deploy modal_app.py`` from services/worker.
The web endpoint requires Modal proxy auth; the Edge API sends the Modal-Key and
Modal-Secret headers. The worker's only configuration is the internal API URL:
it holds no database, Gemini or bucket credentials (ARCHITECTURE section 2).
"""

from __future__ import annotations

import os

import modal

image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_sync(uv_project_dir=".", frozen=True)
    .uv_pip_install("fastapi[standard]==0.119.0")
    .env({"BOWR_MODEL_DIR": "/models", "PYTHONPATH": "/root"})
    # Pinned cutout and embedding weights are fetched and checksum-verified at image build time,
    # never while a job runs (config/models.yaml -> contracts/local_models.json).
    # The whole package, including its JSON contracts (add_local_python_source copies only .py files).
    .add_local_dir("src/bowr_worker", "/root/bowr_worker", copy=True, ignore=["**/__pycache__"])
    .run_commands("python -m bowr_worker.models fetch")
)

app = modal.App("bowr-worker")
config = modal.Secret.from_name("bowr-worker-config")  # BOWR_INTERNAL_API_URL


# IS-Net and FashionCLIP loaded together peak at about 1.75 GiB (local measurement,
# 27 September 2026), so 2 GiB leaves too little room; re-measure on Modal (P1.07-T2).
@app.function(image=image, secrets=[config], timeout=300, max_containers=2, retries=0, cpu=2.0, memory=3072)
def process(wake: dict) -> str:
    import httpx

    from bowr_worker.pipeline import run_job

    with httpx.Client() as client:
        return run_job(wake, os.environ["BOWR_INTERNAL_API_URL"], client)


@app.function(image=image)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
def wake(body: dict) -> dict:
    from bowr_worker.validation import validate

    validate("worker_wake", body)
    # Return promptly; the job's durable record lives in bowr's database.
    process.spawn(body)
    return {"accepted": True}
