"""App badges: a rounded square in the status or app color with a white 10x10 glyph."""
from functools import lru_cache

from PIL import Image

from .model import status_color

SIZE = 14
PADDING = 2


@lru_cache(maxsize=64)
def badge(glyph, level, app_color):
    rows = glyph.split("/")
    if len(rows) != SIZE - 2 * PADDING or any(len(row) != SIZE - 2 * PADDING for row in rows):
        raise ValueError("A badge glyph is ten rows of ten characters.")
    background = status_color(level, app_color)
    image = Image.new("RGB", (SIZE, SIZE), "black")
    for y in range(SIZE):
        for x in range(SIZE):
            if (x in (0, SIZE - 1)) and (y in (0, SIZE - 1)):
                continue
            inside = PADDING <= x < SIZE - PADDING and PADDING <= y < SIZE - PADDING
            lit = inside and rows[y - PADDING][x - PADDING] == "#"
            image.putpixel((x, y), (255, 255, 255) if lit else background)
    return image
