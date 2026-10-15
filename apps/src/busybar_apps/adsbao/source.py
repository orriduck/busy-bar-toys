"""Expose the aircraft checker as a notifier event source."""
import logging
import time

from busybar_notifier.source import Source
from .display import aircraft_icon, notification

LOG = logging.getLogger("busy-bar")


def aircraft_source(checker):
    def poll(now):
        candidate = checker.poll(now)
        return [notification(candidate)] if candidate else []

    def shown(item):
        try:
            checker.mark_alerted(item.payload, time.time())
        except OSError:
            LOG.warning("Could not save aircraft encounter metadata.")

    return Source("adsbao", "adsbao", 1, "event", poll, icon=aircraft_icon(),
                  on_shown=shown, start=checker.start, stop=checker.stop)
