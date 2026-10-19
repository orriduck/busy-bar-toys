"""Render compact bitmaps locally; the device receives ASCII XPM2 only."""
from pathlib import Path
from functools import lru_cache
from datetime import datetime
from zoneinfo import ZoneInfo
from PIL import Image, ImageDraw
from .animation import ANIMATION_FILE, thinking_offset, glow_frame, standby_glow, WIDTH, HEIGHT
from .tokens import compact_tokens, task_usage
from . import profiles
from busybar_shared.graphics import clock_text, clock_font, draw_clock, tiny_text, font, fitted_text, to_xpm

ICON_SIZE, TEXT_WIDTH = 14, 30
ICON_X = round((72-ICON_SIZE-1-TEXT_WIDTH)/2)
TEXT_X = ICON_X+ICON_SIZE+1
COLORS = {"working": "#459AFF", "waiting": "#FFD84A", "done": "#52DE96",
          "error": "#FF5A65", "stopped": "#8893A4", "unknown": "#8893A4"}
def source_icon(source, size=16):
    return profiles.profile(source).icon(size)


def token_labels(usage):
    return (compact_tokens(usage.input_tokens if usage else None),
            compact_tokens(usage.output_tokens if usage else None))


def view_key(tasks, now):
    """What the agent view shows: repaint when this changes, not on a fixed interval."""
    return clock_text(now), tuple(sorted((t.session_id, t.state, token_labels(task_usage(t))) for t in tasks))


def token_fields(usage):
    # Four pixels per tiny glyph. Reserve three glyphs in each direction.
    return tuple(zip(('input','output'), token_labels(usage), (TEXT_X+3,TEXT_X+19)))


def render(task, now, count=1, usage=None):
    source = task.source if task else None
    state = task.state if task else "idle"
    usage = task_usage(task, usage)
    input_tokens = usage.input_tokens if usage else None
    output_tokens = usage.output_tokens if usage else None
    front = Image.new("RGB", (72, 16), "black")
    # Center on the full display, like the native calendar. The status light
    # is an edge overlay and must not push the main content to the right.
    front.paste(source_icon(source, ICON_SIZE), (ICON_X, 1))
    draw = ImageDraw.Draw(front)
    value = clock_text(now)
    clock_width = round(clock_font().getlength(value))
    draw_clock(draw, (TEXT_X + (TEXT_WIDTH-clock_width)//2, 1), value)
    for (direction,label,x),arrow,color in zip(token_fields(usage),('↑','↓'),('#FFBE45','#45D7FF')):
        tiny_text(draw, (x-4,10), arrow, color if usage is not None else '#303030')
        tiny_text(draw, (x,10), label, '#505050')
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
    draw.text((5, 53), "IN " + (f"{input_tokens}/s" if input_tokens is not None else "--"), font=font(10), fill="#AAAAAA")
    draw.text((5, 66), "OUT " + (f"{output_tokens}/s" if output_tokens is not None else "--"), font=font(10), fill="#AAAAAA")
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


def make_payload(task, now, count=1, usage=None):
    images = render(task, now, count, usage)
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
