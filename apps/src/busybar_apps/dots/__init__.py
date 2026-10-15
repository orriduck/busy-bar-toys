"""Your dot agent app: Orbit identity and the five-point source icon."""
from PIL import Image, ImageDraw

from busybar_agents.profiles import AgentProfile, register
from busybar_apps.codex import HOOK_STATES
from busybar_apps.codex.records import WAITING_TOOLS


def dots_icon(size=16):
    # Five independent points: one center and four satellites, drawn on the pixel grid.
    image = Image.new("RGB", (size, size), "black")
    draw = ImageDraw.Draw(image)
    scale = size / 16
    for x, y, radius in [(7.5, 7.5, 2.5), (3, 3, 1.2), (12, 3, 1.2),
                         (3, 12, 1.2), (12, 12, 1.2)]:
        draw.ellipse(tuple(round(v * scale) for v in
                          (x-radius, y-radius, x+radius, y+radius)), fill="white")
    return image


PROFILE = AgentProfile("dots", "Your dot", dots_icon, HOOK_STATES, WAITING_TOOLS)
register(PROFILE)
