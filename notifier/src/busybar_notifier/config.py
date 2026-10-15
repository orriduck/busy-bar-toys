"""Read the private notifier configuration. Every source is off until this file enables it."""
import json
from pathlib import Path

FILE = "notifier.json"


def display_settings(config):
    """Optional `display` section: hold seconds for non-urgent items and snooze minutes for conditions."""
    section = config.get("display") if isinstance(config.get("display"), dict) else {}
    hold = section.get("hold_seconds", 10)
    snooze = section.get("snooze_minutes", 30)
    valid = lambda value, low: type(value) in (int, float) and value >= low
    return {"hold": float(hold) if valid(hold, 1) else 10.0,
            "snooze": float(snooze) * 60 if valid(snooze, 0) else 1800.0}


def read_config(runtime):
    try:
        path = Path(runtime) / FILE
        if path.stat().st_size > 65536:
            return {}
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}
