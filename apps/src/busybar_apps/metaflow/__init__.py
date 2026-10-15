"""Metaflow app: failed runs of watched flows, read with the Metaflow client of a chosen Python."""
from pathlib import Path

from busybar_notifier.badge import badge
from busybar_notifier.model import Notification
from busybar_notifier.seen import SeenStore
from busybar_notifier.source import Source
from busybar_shared.command import run_json

COLOR = (120, 120, 120)
GLYPH = "##......##/###....###/####..####/##.####.##/##..##..##/##......##/##......##/##......##/##......##/##......##"
SCRIPT = Path(__file__).with_name("failures.py")


def sources(config, state_dir, **_):
    flows = list(config.get("flows", ()))
    python = config.get("python")
    if not flows or not python:
        return []
    seen = SeenStore(state_dir / "seen-metaflow.json")
    hours = str(config.get("lookback_hours", 24))

    def poll(now):
        failures = run_json([str(Path(python).expanduser()), str(SCRIPT), hours, *flows], timeout=240)
        return [Notification(f"flow:{f['flow']}/{f['run']}", "attention", "metaflow", "METAFLOW", "OB RUN FAIL",
                             f"{f['flow']}/{f['run']} {f['namespace']}", accent=(229, 165, 10),
                             icon=badge(GLYPH, COLOR))
                for f in seen.fresh(failures, lambda f: f"{f['flow']}/{f['run']}")]

    return [Source("metaflow-failures", "metaflow", 300, "event", poll)]
