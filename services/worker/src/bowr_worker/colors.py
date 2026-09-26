"""Dominant colors from a cutout's foreground (PRD "What to build in Python").

Deterministic k-means over opaque pixels in CIELAB, each center mapped to the
nearest named color. Returns exact hex values for the centers and the share of
foreground each named color covers. No model call.
"""

from __future__ import annotations

import io
import json
from functools import cache
from importlib.resources import files

import numpy as np
from PIL import Image

from .media import MediaRejected

OPAQUE = 200
MAX_SAMPLES = 20_000
MIN_PIXELS = 50
MIN_SHARE = 0.05
CLUSTERS = 5
ITERATIONS = 25


@cache
def palette() -> tuple[list[str], np.ndarray]:
    """Named colors (packages/domain) and their CIELAB coordinates."""
    entries = json.loads(files("bowr_worker.contracts").joinpath("palette.json").read_text())
    rgb = np.array([[int(e["hex"][i : i + 2], 16) for i in (1, 3, 5)] for e in entries], dtype=np.float64)
    return [e["name"] for e in entries], rgb_to_lab(rgb)


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB (0..255) to CIELAB, D65."""
    c = rgb / 255.0
    linear = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    xyz = linear @ np.array(
        [
            [0.4124564, 0.2126729, 0.0193339],
            [0.3575761, 0.7151522, 0.1191920],
            [0.1804375, 0.0721750, 0.9503041],
        ]
    )
    xyz = xyz / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], axis=1)


def _kmeans(points: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    """k-means++ with a fixed seed, so the same pixels always give the same colors."""
    rng = np.random.default_rng(0)
    centers = [points[rng.integers(len(points))]]
    for _ in range(1, k):
        distance = np.min(((points[:, None, :] - np.array(centers)[None]) ** 2).sum(axis=2), axis=1)
        if distance.sum() == 0:
            break
        centers.append(points[rng.choice(len(points), p=distance / distance.sum())])
    centers_array = np.array(centers)
    for _ in range(ITERATIONS):
        labels = np.argmin(((points[:, None, :] - centers_array[None]) ** 2).sum(axis=2), axis=1)
        updated = np.array(
            [
                points[labels == i].mean(axis=0) if np.any(labels == i) else centers_array[i]
                for i in range(len(centers_array))
            ]
        )
        if np.allclose(updated, centers_array):
            break
        centers_array = updated
    labels = np.argmin(((points[:, None, :] - centers_array[None]) ** 2).sum(axis=2), axis=1)
    return centers_array, labels


def dominant_colors(cutout_bytes: bytes, max_colors: int = 5) -> list[dict[str, object]]:
    try:
        with Image.open(io.BytesIO(cutout_bytes), formats=["WEBP", "PNG"]) as image:
            image.load()
            rgba = np.asarray(image.convert("RGBA"))
    except (OSError, SyntaxError, ValueError) as error:
        raise MediaRejected("CORRUPT_IMAGE") from error
    pixels = rgba[rgba[:, :, 3] >= OPAQUE][:, :3].astype(np.float64)
    if len(pixels) < MIN_PIXELS:
        raise MediaRejected("NO_FOREGROUND")
    if len(pixels) > MAX_SAMPLES:
        pixels = pixels[:: len(pixels) // MAX_SAMPLES + 1]

    centers, labels = _kmeans(rgb_to_lab(pixels), CLUSTERS)
    names, named_lab = palette()
    shares: dict[str, float] = {}
    rgb_sums: dict[str, np.ndarray] = {}
    counts: dict[str, int] = {}
    for index in range(len(centers)):
        members = labels == index
        count = int(members.sum())
        if count == 0:
            continue
        name = names[int(np.argmin(((named_lab - centers[index]) ** 2).sum(axis=1)))]
        shares[name] = shares.get(name, 0.0) + count / len(pixels)
        counts[name] = counts.get(name, 0) + count
        rgb_sums[name] = rgb_sums.get(name, np.zeros(3)) + pixels[members].sum(axis=0)
    result = []
    for name, share in sorted(shares.items(), key=lambda pair: (-pair[1], pair[0])):
        if share < MIN_SHARE:
            continue
        mean = rgb_sums[name] / counts[name]
        mean = np.clip(np.round(mean), 0, 255).astype(int)
        result.append(
            {
                "name": name,
                "hex": "#{:02X}{:02X}{:02X}".format(*mean),
                "proportion": round(min(share, 1.0), 3),
            }
        )
    return result[:max_colors]
