"""Aircraft notification: pixel aircraft, flight identity, and type on the shared entrance."""
from dataclasses import replace

from PIL import Image, ImageDraw

from busybar_notifier import display as notice
from busybar_notifier.model import Notification
from busybar_shared.native import FPS
from .proximity import MILE

JADE = (100, 220, 179)
HOLD_SECONDS = 10
ICON_ENTER_FRAMES = notice.ICON_ENTER_FRAMES
BRAND_HOLD_FRAMES = notice.BRAND_HOLD_FRAMES
ENTRANCE_FRAMES = (ICON_ENTER_FRAMES + BRAND_HOLD_FRAMES + notice.CHARACTER_ROLL_FRAMES
                   + (notice.MIN_ROLL_CHARACTERS - 1) * notice.CHARACTER_DELAY_FRAMES)
ENTRANCE_SECONDS = ENTRANCE_FRAMES / FPS
title_image = notice.title_image
title_layers = notice.title_layers


def aircraft_icon():
    image = Image.new("RGB", (16, 14), "black")
    draw = ImageDraw.Draw(image)
    draw.polygon([(15, 6), (11, 5), (9, 5), (5, 0), (3, 0), (5, 5), (2, 5), (1, 3),
                  (0, 3), (0, 10), (1, 10), (2, 8), (5, 8), (3, 13), (5, 13), (9, 8), (11, 8)], fill="white")
    draw.point((9, 5), fill=JADE)
    draw.point((9, 8), fill=JADE)
    return image


def notification(nearby):
    plane = nearby.aircraft
    encounter = getattr(nearby, "encounter_id", None)
    item_id = f"aircraft:{plane.hex}:{encounter}" if encounter else f"aircraft:{plane.hex}"
    item = Notification(item_id, "info", "adsbao", "ADSBAO", plane.identity[:8],
                        (plane.kind or "")[:11], note=f"{plane.identity} {plane.kind} {nearby.distance / MILE:.1f} mi",
                        accent=JADE, icon=aircraft_icon(), payload=nearby)
    return replace(item, hold=notice.entrance_seconds(item) + HOLD_SECONDS)


def render(nearby, *, progress=1, demo=False):
    return notice.render(notification(nearby), progress=progress, demo=demo)


def entrance_asset(nearby):
    return notice.entrance_asset(notification(nearby))
