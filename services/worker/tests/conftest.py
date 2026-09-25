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
