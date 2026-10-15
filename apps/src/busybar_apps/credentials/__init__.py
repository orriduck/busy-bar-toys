"""Credential app: one standing alert lists every configured login that needs renewal."""
from pathlib import Path
import time

from busybar_notifier.badge import badge
from busybar_notifier.model import Notification
from busybar_notifier.source import Source
from busybar_shared.command import CommandError, run

COLOR = (229, 165, 10)
GLYPH = "...####.../..##..##../..#....#../..#....#../##########/##########/####..####/####..####/##########/##########"


def valid(check):
    """A check is a command (optionally with expected output) or a timestamp file with a maximum age."""
    if "stamp" in check:
        try:
            stamp = float(Path(check["stamp"]).expanduser().read_text().strip() or 0)
        except (OSError, ValueError):
            return False
        return time.time() - stamp < float(check.get("max_age_hours", 12)) * 3600
    try:
        result = run(check["command"], timeout=check.get("timeout", 20))
    except CommandError:
        return False
    expect = check.get("expect")
    return expect is None or result.stdout.strip().startswith(expect)


def sources(config, state_dir, **_):
    checks = [c for c in config.get("checks", ()) if isinstance(c, dict) and c.get("name") and ("command" in c or "stamp" in c)]
    if not checks:
        return []

    def poll(now):
        needs = [c["name"] for c in checks if not valid(c)]
        if not needs:
            return []
        return [Notification("credentials:" + ",".join(needs), "attention", "credentials", "LOGIN", "CRED EXPIRE",
                             " | ".join(needs), accent=(229, 165, 10), icon=badge(GLYPH, COLOR))]

    return [Source("credentials", "credentials", config.get("every", 120), "state", poll, icon=badge(GLYPH, COLOR))]
