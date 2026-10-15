"""Staggered character entrance and final view, generalized from the ADSBao alert."""
from functools import lru_cache

from PIL import Image, ImageDraw

from busybar_shared.graphics import clock_font, draw_clock, fitted_text, to_xpm
from busybar_shared.native import FPS, encode_sections, settle, staggered_roll_frame

APP_NAME = "ai-status"
ICON_SIZE = (16, 14)
TEXT_X = ICON_SIZE[0] + 1
TEXT_WIDTH = 72 - TEXT_X
MAX_COMPRESSED_CHARACTERS = 8
ICON_ENTER_FRAMES = 9
BRAND_HOLD_FRAMES = 15
CHARACTER_ROLL_FRAMES = 15
CHARACTER_DELAY_FRAMES = 2
MIN_ROLL_CHARACTERS = 8
SCROLL = {"scroll_rate": 1500, "scroll_start_delay": 1000, "scroll_repeat_delay": 2000}


def _natural_width(text):
    return max(1, round(clock_font().getlength(text)))


def title_fits(title, max_width=TEXT_WIDTH):
    return len(title) <= MAX_COMPRESSED_CHARACTERS or _natural_width(title) <= max_width


@lru_cache(maxsize=256)
def title_image(title, max_width=TEXT_WIDTH):
    """Native bold glyphs. Titles up to eight characters compress; longer titles clip."""
    image = Image.new("RGB", (_natural_width(title), 7))
    draw_clock(ImageDraw.Draw(image), (0, 0), title)
    if bounds := image.getbbox():
        image = image.crop((0, 0, bounds[2], 7))
    if image.width > max_width:
        if title_fits(title, max_width):
            image = image.resize((max_width, 7), Image.Resampling.BOX)
        else:
            image = image.crop((0, 0, max_width, 7))
    return image


@lru_cache(maxsize=256)
def title_layers(title, width):
    """Partition the exact fitted title at its native character boundaries."""
    raw = title_image(title, 255)
    fitted = title_image(title, width)
    scale = fitted.width / raw.width if title_fits(title, width) else 1
    boundaries = [min(fitted.width, round(round(clock_font().getlength(title[:i])) * scale))
                  for i in range(len(title))] + [fitted.width]
    layers = []
    for left, right in zip(boundaries, boundaries[1:]):
        if left >= fitted.width:
            break
        layer = Image.new("RGB", (width, 7))
        layer.paste(fitted.crop((left, 0, right, 7)), (left, 0))
        layers.append(layer)
    return tuple(layers)


def roll_frames(notification):
    count = max(len(title_layers(notification.brand, TEXT_WIDTH)), len(title_layers(notification.title, TEXT_WIDTH)), MIN_ROLL_CHARACTERS)
    return CHARACTER_ROLL_FRAMES + (count - 1) * CHARACTER_DELAY_FRAMES


def entrance_frames(notification):
    return ICON_ENTER_FRAMES + BRAND_HOLD_FRAMES + roll_frames(notification)


def entrance_seconds(notification):
    return entrance_frames(notification) / FPS


def ascii_text(text):
    """Native text elements accept printable ASCII only."""
    return "".join(c if " " <= c <= "~" else "?" for c in str(text)).strip()


def icon_image(notification):
    icon = notification.icon if notification.icon is not None else Image.new("RGB", ICON_SIZE)
    canvas = Image.new("RGB", ICON_SIZE)
    canvas.paste(icon.convert("RGB"), ((ICON_SIZE[0] - icon.width) // 2, (ICON_SIZE[1] - icon.height) // 2))
    return canvas


def render(notification, *, progress=1, demo=False, settled=False):
    """Front and back images. The detail line is native text, drawn after the entrance."""
    total = entrance_frames(notification)
    step = max(0, min(1, progress)) * (total - 1)
    entering = min(1, step / (ICON_ENTER_FRAMES - 1))
    rolling = step - (ICON_ENTER_FRAMES + BRAND_HOLD_FRAMES - 1)
    p = settle(entering)
    front = Image.new("RGB", (72, 16), "black")
    if not (settled and not title_fits(notification.title)):
        rolled = staggered_roll_frame(title_layers(notification.brand, TEXT_WIDTH), title_layers(notification.title, TEXT_WIDTH),
                                      rolling, duration=CHARACTER_ROLL_FRAMES, delay=CHARACTER_DELAY_FRAMES)
        front.paste(rolled.point(lambda value: round(value * p)), (TEXT_X, 1))
    x = round(-TEXT_X + TEXT_X * p)
    icon = icon_image(notification)
    if p < 1:
        for offset, level in ((2, .16), (4, .06)):
            front.paste(icon.point(lambda v: round(v * level * p)), (x - offset, 1))
    front.paste(icon.point(lambda v: round(v * p)), (x, 1))
    back = Image.new("RGB", (64, 32), "black")
    draw = ImageDraw.Draw(back)
    fitted_text(draw, (1, 0), "DEMO" if demo else notification.brand, 62, 9)
    fitted_text(draw, (1, 11), notification.title, 62, 10)
    fitted_text(draw, (1, 23), notification.note or notification.detail, 62, 8)
    return front, back


def entrance_asset(notification):
    total = entrance_frames(notification)
    return encode_sections((72, 16), {"enter": [render(notification, progress=i / (total - 1))[0] for i in range(total)]})


def _hex(rgb):
    return "#{:02X}{:02X}{:02X}FF".format(*rgb)


def text_elements(notification):
    elements = []
    if not title_fits(notification.title) and ascii_text(notification.title):
        elements.append({"id": "notice-title", "type": "text", "display": "front", "text": ascii_text(notification.title),
                         "font": "bold", "color": "#FFFFFFFF", "align": "top_left", "x": TEXT_X, "y": -1,
                         "width": TEXT_WIDTH, "z_index": 35, "timeout": 15, **SCROLL})
    if ascii_text(notification.detail):
        elements.append({"id": "notice-detail", "type": "text", "display": "front", "text": ascii_text(notification.detail),
                         "font": "small", "color": _hex(notification.accent), "align": "top_left", "x": TEXT_X, "y": 8,
                         "width": TEXT_WIDTH, "z_index": 35, "timeout": 15, **SCROLL})
    return elements


def payload(notification, *, demo=False, reduced=False, path=None, settled=False):
    """Draw the final view. Unsettled animated views also start the entrance on top."""
    native_text = reduced or settled
    front, back = render(notification, demo=demo, settled=native_text)
    elements = [{"id": name, "type": "xpmbitmap", "display": name, "x": 0, "y": 0, "timeout": 15,
                 "z_index": 2 if name == "front" else 0, "data": to_xpm(image)}
                for name, image in (("front", front), ("back", back))]
    strip = {"id": "thinking", "display": "front", "x": 0, "y": 0, "z_index": 1, "timeout": 15}
    if reduced:
        strip.update(type="xpmbitmap", data=to_xpm(Image.new("RGB", (4, 16), "black")))
    else:
        strip.update(type="animation", path="notice-blank.anim", loop=True, await_previous_end=True)
    elements.append(strip)
    if not reduced:
        view = {"id": "notice-view", "type": "animation", "display": "front", "x": 0, "y": 0, "z_index": 30,
                "timeout": 15, "loop": False, "await_previous_end": False}
        view.update(path="notice-transparent.anim" if settled else path, **({} if settled else {"section": "enter"}))
        elements.append(view)
    if native_text:
        elements += text_elements(notification)
    return {"application_name": APP_NAME, "priority": 100 if notification.level == "urgent" else 50,
            "elements": elements}
