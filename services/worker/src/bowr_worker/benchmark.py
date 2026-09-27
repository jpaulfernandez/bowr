"""Cutout benchmark (P1.07-T3, A3): cold start, warm time, peak memory and the
stored bytes per piece, for each pinned model.

    uv run python -m bowr_worker.benchmark [--images DIR] [--repeat N]

Without --images it uses the synthetic WARDROBE fixtures' shapes. With a
directory of owner-approved photos it reports only numbers: no file names,
photos or pixels leave this process.
"""

from __future__ import annotations

import argparse
import io
import json
import resource
import statistics
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw

from . import models
from .cutout import SPECS, cutout
from .media import normalize

LIMITS = {"max_bytes": 20 * 1024 * 1024, "max_pixels": 40_000_000, "max_edge": 1024}


def _synthetic() -> list[bytes]:
    """Plain shapes on plain backgrounds, like tests/conftest.py's fixtures."""
    photos = []
    for color, background, points in [
        (
            (31, 42, 77),
            (232, 229, 222),
            [(300, 110), (500, 110), (600, 200), (500, 520), (300, 520), (200, 200)],
        ),
        ((110, 75, 50), (232, 229, 222), [(320, 80), (480, 80), (500, 540), (300, 540)]),
        ((214, 178, 92), (38, 36, 40), [(350, 200), (450, 200), (470, 400), (330, 400)]),
    ]:
        image = Image.new("RGB", (800, 600), background)
        ImageDraw.Draw(image).polygon(points, fill=color)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        photos.append(buffer.getvalue())
    return photos


def _load(directory: Path | None) -> list[tuple[bytes, str]]:
    if directory is None:
        return [(data, "image/png") for data in _synthetic()]
    types = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
    return [
        (path.read_bytes(), types[path.suffix.lower()])
        for path in sorted(directory.iterdir())
        if path.suffix.lower() in types
    ]


def _peak_rss_mib() -> float:
    # ru_maxrss is KiB on Linux.
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)


def run(directory: Path | None, repeat: int) -> dict[str, object]:
    photos = _load(directory)
    originals = [
        normalize(data, declared_content_type=kind, rotation=0, **LIMITS).data for data, kind in photos
    ]
    report: dict[str, object] = {
        "photos": len(originals),
        "source": "owner photos" if directory else "synthetic fixtures",
        "original_bytes_mean": round(statistics.mean(len(o) for o in originals)),
        "models": {},
    }
    for name in SPECS:
        if not models.path_for(name).exists():
            report["models"][name] = {"status": "not fetched"}  # type: ignore[index]
            continue
        started = time.perf_counter()
        models.session(name)
        cold_load = time.perf_counter() - started
        timings, stored = [], []
        failures = 0
        for _ in range(repeat):
            for original in originals:
                started = time.perf_counter()
                try:
                    result = cutout(original, name)
                except Exception:  # a failed photo is counted, not raised
                    failures += 1
                    continue
                timings.append(time.perf_counter() - started)
                stored.append(len(result.cutout.data) + len(result.thumbnail.data) + len(result.mask.data))
        timings.sort()
        report["models"][name] = {  # type: ignore[index]
            "cold_model_load_s": round(cold_load, 2),
            "warm_cutout_s_p50": round(statistics.median(timings), 2) if timings else None,
            "warm_cutout_s_max": round(timings[-1], 2) if timings else None,
            "failures": failures,
            "renditions_bytes_mean": round(statistics.mean(stored)) if stored else None,
            "peak_rss_mib_so_far": _peak_rss_mib(),
        }
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--images", type=Path, default=None)
    parser.add_argument("--repeat", type=int, default=3)
    args = parser.parse_args()
    json.dump(run(args.images, args.repeat), sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
