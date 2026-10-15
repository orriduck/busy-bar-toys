"""Render compact bitmaps locally; the device receives ASCII XPM2 only."""
from pathlib import Path
from functools import lru_cache
from datetime import datetime
from zoneinfo import ZoneInfo
from PIL import Image, ImageDraw
from .animation import ANIMATION_FILE, thinking_offset, glow_frame, standby_glow, WIDTH, HEIGHT
from .network import compact_rate
from . import profiles
from busybar_shared.graphics import clock_text, clock_font, draw_clock, tiny_text, font, fitted_text, to_xpm

ICON_SIZE, TEXT_WIDTH = 14, 30
ICON_X = round((72-ICON_SIZE-1-TEXT_WIDTH)/2)
TEXT_X = ICON_X+ICON_SIZE+1
COLORS = {"working": "#459AFF", "waiting": "#FFD84A", "done": "#52DE96",
          "error": "#FF5A65", "stopped": "#8893A4", "unknown": "#8893A4"}
def source_icon(source, size=16):
    return profiles.profile(source).icon(size)


def rate_label(value):
    compact = compact_rate(value)
    if compact == "--": return "-- B/s"
    unit = {"B": "B/s", "K": "KiB/s", "M": "MiB/s", "G": "GiB/s"}[compact[-1]]
    return compact[:-1] + " " + unit


def total_rate_text(rates):
    if rates is None or rates.upload is None or rates.download is None:
        return '--'
    return compact_rate(rates.upload+rates.download)


def rate_left(value):
    return TEXT_X+(TEXT_WIDTH-(10+len(value)*4-1))//2


def render(task, now, count=1, rates=None):
    source = task.source if task else None
    state = task.state if task else "idle"
    upload = rates.upload if rates else None
    download = rates.download if rates else None
    front = Image.new("RGB", (72, 16), "black")
    # Center on the full display, like the native calendar. The status light
    # is an edge overlay and must not push the main content to the right.
    front.paste(source_icon(source, ICON_SIZE), (ICON_X, 1))
    draw = ImageDraw.Draw(front)
    value = clock_text(now)
    clock_width = round(clock_font().getlength(value))
    draw_clock(draw, (TEXT_X + (TEXT_WIDTH-clock_width)//2, 1), value)
    total = total_rate_text(rates)
    # Two activity indicators and a single aggregate rate fit under the clock.
    left = rate_left(total)
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
    title = profiles.profile(source).title
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


def front_palette(source):
    accent = profiles.profile(source).accent
    if not accent:
        return UI_PALETTE
    grays = [(v,v,v) for v in (0,24,48,80,128,176,224,255)]
    shades = [tuple(round(c * level / 6) for c in accent) for level in range(1, 7)]
    return grays + UI_PALETTE[-2:] + shades


def make_payload(task, now, count=1, rates=None):
    images = render(task, now, count, rates)
    background = images[0].copy()
    # The dedicated widget owns the full glow area; avoid double drawing or
    # spending the clock/icon palette on glow colors.
    ImageDraw.Draw(background).rectangle((0,0,WIDTH-1,HEIGHT-1), fill="black")
    elements = [
        {"id": name, "type": "xpmbitmap", "display": name, "x": 0, "y": 0,
         "timeout": 15, "z_index": 0, "data": to_xpm(image, front_palette(getattr(task, "source", None)) if name == "front" else None)}
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
