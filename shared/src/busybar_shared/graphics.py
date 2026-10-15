"""Shared native clock font, pixel text, and XPM encoding."""
from pathlib import Path
from functools import lru_cache
from datetime import datetime
from zoneinfo import ZoneInfo
from PIL import Image,ImageFont

ASSETS=Path(__file__).parent/"assets"
GLYPHS = {
    "F": ["111","100","110","100","100"], "J": ["001","001","001","101","111"],
    "L": ["100","100","100","100","111"], "Q": ["111","101","101","111","001"],
    "U": ["101","101","101","101","111"], "V": ["101","101","101","101","010"],
    "Y": ["101","101","010","010","010"], "Z": ["111","001","010","100","111"],
    "0": ["111","101","101","101","111"], "1": ["010","110","010","010","111"],
    "2": ["111","001","111","100","111"], "3": ["111","001","111","001","111"],
    "4": ["101","101","111","001","001"], "5": ["111","100","111","001","111"],
    "6": ["111","100","111","101","111"], "7": ["111","001","010","010","010"],
    "8": ["111","101","111","101","111"], "9": ["111","101","111","001","111"],
    "A": ["010","101","111","101","101"], "C": ["111","100","100","100","111"],
    "D": ["110","101","101","101","110"], "E": ["111","100","110","100","111"],
    "H": ["101","101","111","101","101"], "I": ["111","010","010","010","111"],
    "K": ["101","101","110","101","101"], "M": ["101","111","111","101","101"],
    "N": ["101","111","111","111","101"], "O": ["111","101","101","101","111"],
    "P": ["110","101","110","100","100"], "R": ["110","101","110","101","101"],
    "S": ["111","100","111","001","111"], "T": ["111","010","010","010","010"],
    "W": ["101","101","111","111","101"], "X": ["101","101","010","101","101"],
    "+": ["000","010","111","010","000"], " ": ["000"] * 5,
    "B": ["110","101","110","101","110"], "G": ["111","100","101","101","111"],
    "↑": ["010","111","010","010","010"], "↓": ["010","010","010","111","010"],
    ".": ["000","000","000","000","010"], "-": ["000","000","111","000","000"],
    "#": ["101","111","101","111","101"], ":": ["000","010","000","010","000"],
    "/": ["001","001","010","100","100"], "(": ["010","100","100","100","010"],
    ")": ["010","001","001","001","010"], ",": ["000","000","000","010","100"],
    "_": ["000","000","000","000","111"], "!": ["010","010","010","000","010"],
    "?": ["111","001","010","000","010"], "'": ["010","010","000","000","000"],
    "&": ["010","101","010","101","011"], "@": ["111","101","111","100","111"],
    "|": ["010","010","010","010","010"], "=": ["000","111","000","111","000"],
}

def clock_text(now, timezone="America/New_York"):
    return datetime.fromtimestamp(now, ZoneInfo(timezone)).strftime("%H:%M")


@lru_cache(maxsize=1)
def clock_font():
    # Original firmware font: 16 TTF units yields native 6x7 pixel glyphs.
    return ImageFont.truetype(str(ASSETS / "busy_bold_7px.ttf"), 16)


def draw_clock(draw, xy, value):
    face = clock_font()
    top = face.getbbox(value)[1]
    draw.text((xy[0], xy[1]-top), value, font=face, fill="#FFFFFF", stroke_width=0)



def tiny_text(draw, xy, text, fill):
    x, y = xy
    for character in text.upper():
        for row, pixels in enumerate(GLYPHS.get(character, GLYPHS[" "])):
            for col, bit in enumerate(pixels):
                if bit == "1": draw.point((x + col, y + row), fill=fill)
        x += 4


def font(size, *, cjk=False):
    candidates = (["/System/Library/Fonts/PingFang.ttc"] if cjk else []) + [
        "/System/Library/Fonts/Supplemental/Menlo.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    for path in candidates:
        try: return ImageFont.truetype(path, size)
        except OSError: pass
    return ImageFont.load_default(size=size)


def fitted_text(draw, xy, text, max_width, size=12):
    text = "".join(c for c in str(text) if c.isprintable())[:80]
    face = font(size, cjk=not text.isascii())
    while text and draw.textlength(text, font=face) > max_width:
        text = text[:-1]
    draw.text(xy, text, font=face, fill="white")


def to_xpm(image, palette_colors=None):
    image = image.convert("RGB")
    if palette_colors:
        palette_image = Image.new("P", (1,1))
        values = [channel for rgb in palette_colors for channel in rgb]
        palette_image.putpalette(values + [0]*(768-len(values)))
        image = image.quantize(palette=palette_image, dither=Image.Dither.NONE)
    else:
        image = image.quantize(colors=16, dither=Image.Dither.NONE)
    used = sorted(image.getcolors(), key=lambda pair: pair[1])
    palette = image.getpalette()
    symbols = "ABCDEFGHIJKLMNOP"
    lookup = {index: symbols[i] for i, (_, index) in enumerate(used)}
    lines = ["! XPM2", f"{image.width} {image.height} {len(used)} 1"]
    for _, index in used:
        red, green, blue = palette[index*3:index*3+3]
        lines.append(f"{lookup[index]} c #{red:02X}{green:02X}{blue:02X}")
    pixels = list(image.get_flattened_data() if hasattr(image, "get_flattened_data") else image.getdata())
    lines.extend("".join(lookup[p] for p in pixels[y*image.width:(y+1)*image.width])
                 for y in range(image.height))
    return "\n".join(lines) + "\n"
