"""Codex agent app: rollout records, hook mapping, and the ChatGPT source icon."""
from pathlib import Path

from PIL import Image, ImageOps

from busybar_agents.profiles import AgentProfile, register
from .records import WAITING_TOOLS

ASSETS = Path(__file__).parent / "assets"
HOOK_STATES = {"UserPromptSubmit": "working", "PreToolUse": "working",
               "PostToolUse": "working", "PermissionRequest": "waiting",
               "Stop": "done", "Interrupt": "stopped"}


def chatgpt_icon(size=16):
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


PROFILE = AgentProfile("chatgpt", "ChatGPT", chatgpt_icon, HOOK_STATES, WAITING_TOOLS,
                       aliases=frozenset({"codex"}))
register(PROFILE, default=True)
