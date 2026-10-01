#!/usr/bin/env python3
"""Replace TJUClaw icons from a rounded app icon, dropping the black canvas."""

import sys
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def outside(r, g, b):
    return r < 28 and g < 36 and b < 48


def strip_canvas(src: Image.Image) -> Image.Image:
    image = src.convert("RGBA")
    w, h = image.size
    pix = image.load()
    seen = bytearray(w * h)
    queue = deque(((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)))
    for x, y in queue:
        seen[y * w + x] = 1
    while queue:
        x, y = queue.popleft()
        r, g, b, _ = pix[x, y]
        if not outside(r, g, b):
            continue
        pix[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx]:
                seen[ny * w + nx] = 1
                queue.append((nx, ny))
    for _ in range(8):
        fringe = []
        for y in range(h):
            for x in range(w):
                r, g, b, a = pix[x, y]
                if a == 0 or b >= 90 or r > 50:
                    continue
                if any(
                    pix[nx, ny][3] == 0
                    for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1))
                    if 0 <= nx < w and 0 <= ny < h
                ):
                    fringe.append((x, y))
        if not fringe:
            break
        for x, y in fringe:
            pix[x, y] = (0, 0, 0, 0)
    plate = image.crop(image.getbbox())
    side = max(plate.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(plate, ((side - plate.size[0]) // 2, (side - plate.size[1]) // 2), plate)
    return canvas


def fill_color(icon: Image.Image):
    pix = icon.load()
    side = icon.size[0]
    sample = []
    for t in range(side // 5, 4 * side // 5, 7):
        for point in (pix[t, 8], pix[t, side - 9], pix[8, t], pix[side - 9, t]):
            if point[3] > 200 and point[2] > 80:
                sample.append(point[:3])
    if not sample:
        return (20, 100, 200)
    return tuple(sum(pixel[i] for pixel in sample) // len(sample) for i in range(3))


def opaque(icon: Image.Image) -> Image.Image:
    filled = Image.new("RGBA", icon.size, fill_color(icon) + (255,))
    filled.paste(icon, (0, 0), icon)
    return filled.convert("RGB")


def save_png(icon: Image.Image, path: Path, size: int, flatten=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    resized = icon.resize((size, size), Image.Resampling.LANCZOS)
    if flatten:
        resized = opaque(resized)
    resized.save(path, optimize=True)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: replace-app-icon.py SOURCE")
    source = Path(sys.argv[1])
    icon = strip_canvas(Image.open(source))
    save_png(icon, ROOT / "frontend/app-icon.png", 1024)
    save_png(icon, ROOT / "frontend/favicon.png", 64)
    save_png(icon, ROOT / "frontend/public/icons/icon-192.png", 192)
    save_png(icon, ROOT / "frontend/public/icons/icon-512.png", 512)
    save_png(icon, ROOT / "frontend/public/icons/apple-touch-icon.png", 180, flatten=True)
    save_png(icon, ROOT / "frontend/public/icons/icon-maskable-512.png", 512, flatten=True)
    save_png(icon, ROOT / "docs/public/favicon.png", 64)
    save_png(icon, ROOT / "draw/public/favicon.png", 64)
    brand = icon.resize((512, 512), Image.Resampling.LANCZOS)
    brand.save(ROOT / "frontend/src/assets/brand-icon.webp", quality=90, method=6)
    brand.save(ROOT / "docs/public/tjuclaw-icon.webp", quality=90, method=6)
    icon.resize((64, 64), Image.Resampling.LANCZOS).save(ROOT / "docs/public/favicon.webp", quality=90, method=6)
    print(f"wrote icons from {source} ({icon.size[0]}px plate)")


if __name__ == "__main__":
    main()
