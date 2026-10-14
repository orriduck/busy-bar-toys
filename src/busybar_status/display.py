"""Render compact bitmaps locally; the device receives ASCII XPM2 only."""
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
from PIL import Image, ImageDraw, ImageFont, ImageOps
from .animation import ANIMATION_FILE, thinking_offset

ASSETS = Path(__file__).parent / "assets"
COLORS = {"working": "#459AFF", "waiting": "#FFBE45", "done": "#52DE96",
          "error": "#FF5A65", "stopped": "#8893A4", "unknown": "#8893A4"}
LABELS = {"working": "WORK", "waiting": "WAIT", "done": "DONE",
          "error": "ERROR", "stopped": "STOP", "unknown": "CHECK"}
GLYPHS = {
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
}

CLOCK_DIGITS = {
    "0": ["01110","10001","10011","10101","11001","10001","01110"],
    "1": ["00100","01100","00100","00100","00100","00100","01110"],
    "2": ["01110","10001","00001","00010","00100","01000","11111"],
    "3": ["11110","00001","00001","01110","00001","00001","11110"],
    "4": ["00010","00110","01010","10010","11111","00010","00010"],
    "5": ["11111","10000","10000","11110","00001","00001","11110"],
    "6": ["01110","10000","10000","11110","10001","10001","01110"],
    "7": ["11111","00001","00010","00100","01000","01000","01000"],
    "8": ["01110","10001","10001","01110","10001","10001","01110"],
    "9": ["01110","10001","10001","01111","00001","00001","01110"],
    ":": ["0","1","1","0","1","1","0"],
}


def clock_text(now, timezone="America/New_York"):
    return datetime.fromtimestamp(now, ZoneInfo(timezone)).strftime("%H:%M")


def draw_clock(draw, xy, value):
    x,y = xy
    for character in value:
        glyph = CLOCK_DIGITS[character]
        for row,pixels in enumerate(glyph):
            for col,bit in enumerate(pixels):
                if bit == "1": draw.point((x+col,y+row), fill="#FFFFFF")
        x += len(glyph[0])+1


def tiny_text(draw, xy, text, fill):
    x, y = xy
    for character in text.upper():
        for row, pixels in enumerate(GLYPHS.get(character, GLYPHS[" "])):
            for col, bit in enumerate(pixels):
                if bit == "1": draw.point((x + col, y + row), fill=fill)
        x += 4


def source_icon(source, size=16):
    if source == "dots":
        # Five independent points: one center and four satellites, drawn on the pixel grid.
        image = Image.new("RGB", (size, size), "black")
        draw = ImageDraw.Draw(image)
        scale = size / 16
        for x, y, radius in [(7.5, 7.5, 2.5), (3, 3, 1.2), (12, 3, 1.2),
                             (3, 12, 1.2), (12, 12, 1.2)]:
            draw.ellipse(tuple(round(v * scale) for v in
                              (x-radius, y-radius, x+radius, y+radius)), fill="white")
        return image
    with Image.open(ASSETS / "chatgpt.png") as original:
        # Convert the official black-on-white icon into a white mask on the LED's black canvas.
        mask = ImageOps.invert(original.convert("RGB").convert("L"))
        # Retain the source mark's square proportions and internal negative spaces.
        bounds = mask.point(lambda value: 255 if value > 120 else 0).getbbox()
        if bounds:
            side = max(bounds[2]-bounds[0], bounds[3]-bounds[1]) + 10
            cx, cy = (bounds[0]+bounds[2])/2, (bounds[1]+bounds[3])/2
            mask = mask.crop((round(cx-side/2), round(cy-side/2),
                              round(cx+side/2), round(cy+side/2)))
        mask = mask.resize((size, size), Image.Resampling.LANCZOS)
        return Image.merge("RGB", (mask, mask, mask))


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


def render(task, now, count=1):
    front = Image.new("RGB", (72, 16), "black")
    front.paste(source_icon(task.source), (0, 0))
    draw = ImageDraw.Draw(front)
    color = COLORS[task.state]
    elapsed = max(0, int(now - task.started_at))
    draw_clock(draw, (20, 1), clock_text(now))
    tiny_text(draw, (52, 2), LABELS[task.state], color)
    minutes = elapsed // 60
    tiny_text(draw, (20, 10), f"{min(minutes, 999)}M", "#8893A4")
    if count > 1: tiny_text(draw, (52, 10), f"X{min(count,99)}", color)
    draw.line((20, 15, 71, 15), fill="#102030")
    if task.state == "working":
        x = 20 + thinking_offset(now)
        draw.line((x, 15, x + 5, 15), fill=color)
    else:
        draw.line((20, 15, 71, 15), fill=color)

    back = Image.new("RGB", (160, 80), "black")
    back.paste(source_icon(task.source, 24), (4, 4))
    draw = ImageDraw.Draw(back)
    draw.text((36, 5), "Your dot" if task.source == "dots" else "ChatGPT", font=font(16), fill="white")
    draw.text((5, 29), clock_text(now), font=font(18), fill="white")
    draw.text((88, 33), LABELS[task.state], font=font(11), fill="white")
    fitted_text(draw, (5, 51), task.project or "AI task", 135, 12)
    draw.text((5, 68), f"{minutes:02d}:{elapsed%60:02d}  |  {count} active", font=font(9), fill="#AAAAAA")
    return front, back


def to_xpm(image):
    image = image.convert("RGB").quantize(colors=16, dither=Image.Dither.NONE)
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


def make_payload(task, now, count=1):
    images = render(task, now, count)
    elements = [
        {"id": name, "type": "xpmbitmap", "display": name, "x": 0, "y": 0,
         "timeout": 15, "data": to_xpm(image)}
        for name, image in zip(("front", "back"), images)]
    strip = {"id": "thinking", "display": "front", "x": 20, "y": 15,
             "timeout": 15, "z_index": 1}
    if task.state == "working":
        strip.update(type="animation", path=ANIMATION_FILE, loop=True,
                     await_previous_end=True, section="default")
    else:
        strip.update(type="xpmbitmap", data=to_xpm(images[0].crop((20,15,72,16))))
    elements.append(strip)
    return {"application_name": "ai-status", "priority": 50, "elements": elements}
