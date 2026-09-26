"""MEDIA fixtures (test-strategy.md), generated synthetically at test time.

No real photos are committed. Each helper returns encoded bytes.
"""

from __future__ import annotations

import io

import pillow_heif
from PIL import Image, ImageCms

pillow_heif.register_heif_opener()


def two_tone(width: int = 400, height: int = 200, mode: str = "RGB") -> Image.Image:
    """Left half red, right half blue, so orientation changes are observable."""
    image = Image.new(mode, (width, height), (255, 0, 0) if mode == "RGB" else (255, 0, 0, 255))
    image.paste((0, 0, 255) if mode == "RGB" else (0, 0, 255, 255), (width // 2, 0, width, height))
    return image


def encode(image: Image.Image, fmt: str, **options: object) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt, **options)
    return buffer.getvalue()


def jpeg_with_orientation_and_gps(orientation: int = 6) -> bytes:
    exif = Image.Exif()
    exif[0x0112] = orientation
    exif[0x010F] = "FixtureCam"
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"
    gps[2] = (14.0, 35.0, 0.0)
    gps[3] = "E"
    gps[4] = (121.0, 0.0, 0.0)
    return encode(two_tone(), "JPEG", exif=exif.tobytes(), quality=90)


def with_srgb_profile(image: Image.Image, fmt: str) -> bytes:
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    return encode(image, fmt, icc_profile=profile)


def animated(fmt: str) -> bytes:
    frames = [Image.new("RGB", (32, 32), color) for color in ((255, 0, 0), (0, 255, 0))]
    buffer = io.BytesIO()
    frames[0].save(buffer, format=fmt, save_all=True, append_images=frames[1:], duration=100, loop=0)
    return buffer.getvalue()


def webp_chunks(data: bytes) -> list[str]:
    """RIFF chunk identifiers in a WebP file."""
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    chunks: list[str] = []
    offset = 12
    while offset + 8 <= len(data):
        name = data[offset : offset + 4].decode("ascii")
        size = int.from_bytes(data[offset + 4 : offset + 8], "little")
        chunks.append(name)
        offset += 8 + size + (size % 2)
    return chunks


def garment(
    width: int = 800, height: int = 600, background: tuple[int, int, int] = (232, 229, 222)
) -> Image.Image:
    """A navy shirt silhouette on a plain light background (a hanger-style photo)."""
    from PIL import ImageDraw

    image = Image.new("RGB", (width, height), background)
    sx, sy = width / 800, height / 600
    points = [
        (300, 110),
        (500, 110),
        (600, 200),
        (555, 250),
        (500, 215),
        (500, 520),
        (300, 520),
        (300, 215),
        (245, 250),
        (200, 200),
    ]
    ImageDraw.Draw(image).polygon([(x * sx, y * sy) for x, y in points], fill=(31, 42, 77))
    return image


def garment_truth(width: int = 800, height: int = 600) -> list[list[bool]]:
    """Pixel truth for ``garment()``: True where the shirt is."""
    import numpy as np

    pixels = np.asarray(garment(width, height)).astype(int)
    return (pixels[:, :, 0] < 100) & (pixels[:, :, 2] > 60)


def trousers(width: int = 800, height: int = 600) -> Image.Image:
    """Brown trousers on a plain light background: a second, distinguishable piece."""
    from PIL import ImageDraw

    image = Image.new("RGB", (width, height), (232, 229, 222))
    sx, sy = width / 800, height / 600
    points = [(320, 80), (480, 80), (500, 540), (420, 540), (400, 250), (380, 540), (300, 540)]
    ImageDraw.Draw(image).polygon([(x * sx, y * sy) for x, y in points], fill=(110, 75, 50))
    return image


def care_label(width: int = 600, height: int = 400) -> Image.Image:
    """A white care label with dark printed lines (no real text or brand)."""
    from PIL import ImageDraw

    image = Image.new("RGB", (width, height), (40, 40, 44))
    draw = ImageDraw.Draw(image)
    draw.rectangle((100, 60, 500, 340), fill=(248, 248, 244))
    for row in range(6):
        y = 90 + row * 40
        draw.rectangle((130, y, 470 - (row % 3) * 60, y + 12), fill=(30, 30, 30))
    return image
