"""Claude Code agent app: hook mapping, local turns, and the Claude source icon."""
from pathlib import Path

from PIL import Image, ImageChops

from busybar_agents.profiles import AgentProfile, register

ASSETS = Path(__file__).parent / "assets"
WAITING_NOTIFICATIONS = frozenset({"permission_prompt", "elicitation_dialog"})


def notification_state(payload):
    kind = payload.get("notification_type")
    if isinstance(kind, str):
        return "waiting" if kind in WAITING_NOTIFICATIONS else None
    message = payload.get("message")
    return "waiting" if isinstance(message, str) and "permission" in message.lower() else None


HOOK_STATES = {"UserPromptSubmit": "working", "PreToolUse": "working",
               "PostToolUse": "working", "Notification": notification_state,
               "Stop": "done", "SessionEnd": "stopped"}


def claude_icon(size=16):
    with Image.open(ASSETS / "claude.png") as original:
        red, _, blue = original.convert("RGB").split()
        mask = ImageChops.subtract(red, blue).point(lambda value: max(0, min(255, (value - 50) * 3)))
        bounds = mask.point(lambda value: 255 if value > 120 else 0).getbbox()
        if bounds:
            side = max(bounds[2]-bounds[0], bounds[3]-bounds[1]) + 6
            cx, cy = (bounds[0]+bounds[2])/2, (bounds[1]+bounds[3])/2
            mask = mask.crop((round(cx-side/2), round(cy-side/2),
                              round(cx+side/2), round(cy+side/2)))
        mask = mask.resize((size, size), Image.Resampling.LANCZOS)
        return Image.merge("RGB", (mask, mask, mask))


PROFILE = AgentProfile("claude", "Claude", claude_icon, HOOK_STATES,
                       new_turn_events=frozenset({"UserPromptSubmit"}))
register(PROFILE)
