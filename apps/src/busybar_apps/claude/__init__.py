"""Claude Code agent app: hook mapping, local turns, and a spark source icon."""
import math

from PIL import Image, ImageDraw

from busybar_agents.profiles import AgentProfile, register

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


def spark_icon(size=16):
    """An eight-ray spark, supersampled and thresholded to the pixel grid."""
    scale = 8
    big = Image.new("L", (size * scale, size * scale))
    draw = ImageDraw.Draw(big)
    center = size * scale / 2
    for ray, length in enumerate((1.0, .72, .94, .68, 1.0, .72, .94, .68)):
        angle = math.pi / 2 + ray * math.pi / 4
        reach = center * .98 * length
        half = scale * 1.1
        cos, sin = math.cos(angle), math.sin(angle)
        draw.polygon([(center - sin * half, center + cos * half),
                      (center + cos * reach, center + sin * reach),
                      (center + sin * half, center - cos * half)], fill=255)
    draw.ellipse([center - scale * 1.6, center - scale * 1.6, center + scale * 1.6, center + scale * 1.6], fill=255)
    mask = big.resize((size, size), Image.Resampling.BOX).point(lambda v: 255 if v > 90 else 0)
    return Image.merge("RGB", (mask, mask, mask))


PROFILE = AgentProfile("claude", "Claude", spark_icon, HOOK_STATES,
                       new_turn_events=frozenset({"UserPromptSubmit"}))
register(PROFILE)
