"""Render compact bitmaps locally; the device receives ASCII XPM2 only."""
from pathlib import Path
from functools import lru_cache
from datetime import datetime
from zoneinfo import ZoneInfo
from PIL import Image, ImageDraw, ImageFont, ImageOps
from .animation import ANIMATION_FILE, thinking_offset, glow_frame, standby_glow, WIDTH, HEIGHT
from .network import compact_rate

ASSETS = Path(__file__).parent / "assets"
COLORS = {"working": "#459AFF", "waiting": "#FFD84A", "done": "#52DE96",
          "error": "#FF5A65", "stopped": "#8893A4", "unknown": "#8893A4"}
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
    "B": ["110","101","110","101","110"], "G": ["111","100","101","101","111"],
    "↑": ["010","111","010","010","010"], "↓": ["010","010","010","111","010"],
    ".": ["000","000","000","000","010"], "-": ["000","000","111","000","000"],
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


def rate_label(value):
    compact = compact_rate(value)
    if compact == "--": return "-- B/s"
    unit = {"B": "B/s", "K": "KiB/s", "M": "MiB/s", "G": "GiB/s"}[compact[-1]]
    return compact[:-1] + " " + unit


def render(task, now, count=1, rates=None):
    source = task.source if task else "chatgpt"
    state = task.state if task else "idle"
    upload = rates.upload if rates else None
    download = rates.download if rates else None
    front = Image.new("RGB", (72, 16), "black")
    # Center on the full display, like the native calendar. The status light
    # is an edge overlay and must not push the main content to the right.
    icon_size, text_width, gap = 14, 30, 1
    icon_x = round((front.width-icon_size-gap-text_width)/2)
    text_x = icon_x+icon_size+gap
    front.paste(source_icon(source, icon_size), (icon_x, 1))
    draw = ImageDraw.Draw(front)
    value = clock_text(now)
    clock_width = round(clock_font().getlength(value))
    draw_clock(draw, (text_x + (text_width-clock_width)//2, 1), value)
    total = compact_rate(upload+download if upload is not None and download is not None else None)
    # Two activity indicators and a single aggregate rate fit under the clock.
    line_width = 10 + len(total)*4-1
    left = text_x + (text_width-line_width)//2
    tiny_text(draw, (left, 10), "↑", "#FFBE45" if upload is not None and upload>0 else "#303030")
    tiny_text(draw, (left+4, 10), "↓", "#45D7FF" if download is not None and download>0 else "#303030")
    tiny_text(draw, (left+10, 10), total, "#505050")
    color = tuple(bytes.fromhex(COLORS.get(state, "#28313C")[1:]))
    if state in {"idle", "done", "stopped"}:
        light = standby_glow()
    else:
        light = glow_frame(now, color, moving=state == "working")
    front.paste(Image.frombytes("RGB", (WIDTH,HEIGHT), light), (0,0))
    back = Image.new("RGB", (160, 80), "black")
    draw = ImageDraw.Draw(back)
    back.paste(source_icon(source, 24), (4, 4))
    title = "Your dot" if source == "dots" else "ChatGPT"
    demo = getattr(task, "session_id", None) == "demo"
    draw.text((36, 5), title + (" DEMO" if demo else ""),
              font=font(12 if demo else 16), fill="white")
    draw.text((5, 29), clock_text(now), font=font(18), fill="white")
    draw.text((5, 53), "UP " + rate_label(upload), font=font(10), fill="#AAAAAA")
    draw.text((5, 66), "DN " + rate_label(download), font=font(10), fill="#AAAAAA")
    return front, back


# Reserve the two arrow colors so a tiny colored arrow cannot be averaged
# into the much larger grayscale icon during 16-color XPM quantization.
UI_PALETTE = [(v,v,v) for v in (0,24,48,64,80,96,112,128,144,160,176,192,224,255)] + [
    (255,190,69), (69,215,255)]


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


def make_payload(task, now, count=1, rates=None):
    images = render(task, now, count, rates)
    background = images[0].copy()
    # The dedicated widget owns the full glow area; avoid double drawing or
    # spending the clock/icon palette on glow colors.
    ImageDraw.Draw(background).rectangle((0,0,WIDTH-1,HEIGHT-1), fill="black")
    elements = [
        {"id": name, "type": "xpmbitmap", "display": name, "x": 0, "y": 0,
         "timeout": 15, "data": to_xpm(image, UI_PALETTE if name == "front" else None)}
        for name, image in zip(("front", "back"), (background,images[1]))]
    strip = {"id": "thinking", "display": "front", "x": 0, "y": 0,
             "timeout": 15, "z_index": 1}
    if task and task.state == "working":
        strip.update(type="animation", path=ANIMATION_FILE, loop=True,
                     await_previous_end=True, section="default")
    else:
        light = images[0].crop((0,0,WIDTH,HEIGHT))
        # Preserve the bright state-colored core rather than averaging its few
        # pixels into the much more numerous dim halo pixels.
        raw = light.tobytes()
        peak = max(zip(raw[0::3],raw[1::3],raw[2::3]),key=sum)
        light_palette = [tuple(round(c*level/15) for c in peak) for level in range(16)]
        strip.update(type="xpmbitmap", data=to_xpm(light, light_palette))
    elements.append(strip)
    return {"application_name": "ai-status", "priority": 50, "elements": elements}
