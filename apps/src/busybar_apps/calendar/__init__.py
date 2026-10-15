"""Calendar app: a meeting alert a few minutes before it starts, read with icalBuddy."""
from datetime import datetime

from busybar_notifier.badge import badge
from busybar_notifier.model import Notification
from busybar_notifier.seen import SeenStore
from busybar_notifier.source import Source
from busybar_shared.command import run

COLOR = (66, 133, 244)
GLYPH = "..#....#../##########/#........#/#.##..##.#/#.##..##.#/#........#/#.##..##.#/#.##..##.#/#........#/##########"
ARGS = ["icalBuddy", "-n", "-nc", "-nrd", "-ea", "-b", "", "-ps", "|\t|", "-iep", "datetime,title",
        "-po", "datetime,title", "-df", "%Y-%m-%d", "-tf", "%H:%M", "eventsToday"]


def upcoming(output, now, lead):
    for line in output.splitlines():
        when, _, title = line.partition("\t")
        try:
            day, _, clock = when.strip().partition(" at ")
            start = datetime.strptime(f"{day} {clock[:5]}", "%Y-%m-%d %H:%M").timestamp()
        except ValueError:
            continue
        if title.strip() and 0 <= start - now <= lead:
            yield {"start": start, "time": clock[:5], "title": title.strip()}


def sources(config, state_dir, **_):
    seen = SeenStore(state_dir / "seen-calendar.json")
    lead = float(config.get("lead_minutes", 2)) * 60

    def poll(now):
        events = list(upcoming(run(ARGS, timeout=20).stdout, now, lead))
        return [Notification(f"meeting:{int(e['start'])}:{e['title'][:40]}", "info", "calendar", "CALENDAR", "MEETING",
                             f"{e['time']} {e['title']}", accent=(140, 180, 255), icon=badge(GLYPH, "info", COLOR))
                for e in seen.fresh(events, lambda e: f"{int(e['start'])}:{e['title']}")]

    return [Source("calendar", "calendar", 30, "event", poll)]
