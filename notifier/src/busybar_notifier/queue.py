"""Choose the visible notification: urgent first, then new events, then standing conditions."""
import threading
import time

from .model import HOLD, LEVEL_RANK, SNOOZE

MAX_TICK = 5.0


class NotificationQueue:
    def __init__(self, *, clock=None, hold=HOLD, snooze=SNOOZE):
        """Non-urgent items hide after `hold` visible seconds; conditions return after `snooze`."""
        self.clock = clock or time.monotonic
        self.hold = hold
        self.snooze = snooze
        self._lock = threading.Lock()
        self._states = {}
        self._events = []
        self._dismissed = set()
        self._state_visible = {}
        self._snoozed = {}
        self._last_mark = None

    def set_state(self, source, notifications):
        with self._lock:
            self._states[source] = list(notifications)

    def push(self, notifications):
        with self._lock:
            for item in notifications:
                if not any(e["item"].id == item.id for e in self._events):
                    self._events.append({"item": item, "at": self.clock(), "shown": None})

    def current(self):
        with self._lock:
            return self._current()

    def _current(self):
        now = self.clock()
        for event in [e for e in self._events if e["shown"] is not None and now - e["shown"] > e["item"].event_hold(self.hold)]:
            self._drop_group(event["item"])
        for key, visible in list(self._state_visible.items()):
            if visible > self.hold:
                self._snoozed[key] = now + self.snooze
                del self._state_visible[key]
        states = [item for items in self._states.values() for item in items]
        live = {item.id for item in states} | {e["item"].id for e in self._events}
        self._dismissed &= live
        self._snoozed = {k: v for k, v in self._snoozed.items() if k in live and v > now}
        self._state_visible = {k: v for k, v in self._state_visible.items() if k in live}
        candidates = [(item, 0.0, False) for item in states] + [(e["item"], e["at"], True) for e in self._events]
        candidates = [c for c in candidates if c[0].id not in self._dismissed and c[0].id not in self._snoozed]

        def rank(candidate):
            item, at, event = candidate
            base = 0 if item.level == "urgent" else (10 if event else 20) + LEVEL_RANK[item.level]
            return (base, -at)

        candidates.sort(key=rank)
        groups, visible = set(), []
        for item, _, _ in candidates:
            group = item.group or item.id
            if group not in groups:
                groups.add(group)
                visible.append(item)
        return (visible[0], len(visible) - 1) if visible else (None, 0)

    def mark_shown(self, item_id):
        with self._lock:
            now = self.clock()
            event = next((e for e in self._events if e["item"].id == item_id), None)
            if event:
                if event["shown"] is None:
                    event["shown"] = now
            elif any(item.id == item_id and item.level != "urgent" for items in self._states.values() for item in items):
                elapsed = min(now - self._last_mark[1], MAX_TICK) if self._last_mark and self._last_mark[0] == item_id else 0
                self._state_visible[item_id] = self._state_visible.get(item_id, 0) + elapsed
            self._last_mark = (item_id, now)

    def dismiss(self, item_id):
        with self._lock:
            self._dismissed.add(item_id)
            event = next((e for e in self._events if e["item"].id == item_id), None)
            if event:
                self._drop_group(event["item"])

    def dismiss_all_except_urgent(self):
        with self._lock:
            for items in self._states.values():
                self._dismissed |= {item.id for item in items if item.level != "urgent"}
            self._events = [e for e in self._events if e["item"].level == "urgent"]

    def _drop_group(self, item):
        group = item.group or item.id
        self._events = [e for e in self._events if (e["item"].group or e["item"].id) != group]
