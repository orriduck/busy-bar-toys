"""Terminal app: `busy-bar run -- COMMAND` reports when a long command finishes."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

from busybar_notifier.badge import badge
from busybar_notifier.model import Notification
from busybar_notifier.source import Source

COLOR = (45, 164, 78)
GLYPH = "##......../.##......./..##....../...##...../..##....../.##......./##......../........../....######/....######"


def duration(seconds):
    seconds = int(seconds)
    if seconds >= 3600:
        return f"{seconds // 3600}h{seconds % 3600 // 60}m"
    return f"{seconds // 60}m{seconds % 60}s" if seconds >= 60 else f"{seconds}s"


def run_and_report(inbox, command):
    """Run the command in the foreground, then leave a private note for the service."""
    started = time.monotonic()
    code = subprocess.call(command)
    inbox = Path(inbox)
    inbox.mkdir(mode=0o700, parents=True, exist_ok=True)
    note = {"command": " ".join(command)[:200], "code": code, "seconds": round(time.monotonic() - started)}
    fd, temporary = tempfile.mkstemp(prefix=".note-", dir=inbox)
    with os.fdopen(fd, "w") as handle:
        json.dump(note, handle)
    os.replace(temporary, inbox / f"{time.time_ns()}-{os.getpid()}.json")
    return code


def sources(config, state_dir, *, inbox, **_):
    inbox = Path(inbox)

    def poll(now):
        items = []
        for path in sorted(inbox.glob("*.json")):
            try:
                note = json.loads(path.read_text()) if path.stat().st_size <= 4096 else None
            except (OSError, ValueError):
                note = None
            path.unlink(missing_ok=True)
            if not isinstance(note, dict) or not isinstance(note.get("code"), int):
                continue
            done = note["code"] == 0
            level = "info" if done else "attention"
            prefix = "" if done else f"exit {note['code']}: "
            detail = f"{prefix}{note.get('command', '')} ({duration(note.get('seconds', 0))})"
            items.append(Notification(f"task:{path.stem}", level, "terminal", "TERMINAL", "DONE" if done else "FAILED",
                                      detail, accent=(82, 222, 150) if done else (229, 165, 10), icon=badge(GLYPH, COLOR)))
        return items

    return [Source("terminal-tasks", "terminal", 3, "event", poll)]
