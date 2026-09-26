"""Pinned local models (config/models.yaml -> contracts/local_models.json).

Weights are fetched at build time (the worker image, ``pnpm worker:models``),
verified against their SHA-256 and loaded from ``BOWR_MODEL_DIR``. Nothing is
downloaded while a job runs; a missing or altered file is MODEL_UNAVAILABLE.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import threading
from functools import cache
from importlib.resources import files
from pathlib import Path
from typing import Any

MODEL_DIR = Path(os.environ.get("BOWR_MODEL_DIR", Path(__file__).resolve().parents[2] / "models"))


class ModelUnavailable(Exception):
    """The pinned weights are absent or do not match their checksum."""


@cache
def manifest() -> dict[str, dict[str, str]]:
    return json.loads(files("bowr_worker.contracts").joinpath("local_models.json").read_text())


def path_for(name: str) -> Path:
    return MODEL_DIR / f"{name}.onnx"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


_lock = threading.Lock()
_sessions: dict[str, Any] = {}


def session(name: str) -> Any:
    """A cached onnxruntime session for a pinned model, verified once per process."""
    with _lock:
        if name in _sessions:
            return _sessions[name]
        entry = manifest().get(name)
        path = path_for(name)
        if entry is None or not path.is_file() or _sha256(path) != entry["sha256"]:
            raise ModelUnavailable(name)
        import onnxruntime

        options = onnxruntime.SessionOptions()
        options.log_severity_level = 3
        _sessions[name] = onnxruntime.InferenceSession(
            str(path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        return _sessions[name]


def fetch(names: list[str] | None = None) -> None:
    """Downloads pinned weights that are missing, verifying each checksum."""
    import httpx

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    for name, entry in manifest().items():
        if names and name not in names:
            continue
        target = path_for(name)
        if target.is_file() and _sha256(target) == entry["sha256"]:
            print(f"{name}: present")
            continue
        partial = target.with_suffix(".part")
        with httpx.stream("GET", entry["source"], follow_redirects=True, timeout=300) as response:
            response.raise_for_status()
            with partial.open("wb") as handle:
                for chunk in response.iter_bytes(1 << 20):
                    handle.write(chunk)
        if _sha256(partial) != entry["sha256"]:
            partial.unlink()
            raise SystemExit(f"{name}: checksum mismatch; refusing to install")
        partial.replace(target)
        print(f"{name}: fetched and verified")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch pinned local models")
    parser.add_argument("command", choices=["fetch"])
    parser.add_argument("names", nargs="*")
    args = parser.parse_args()
    fetch(args.names or None)


if __name__ == "__main__":
    main()
