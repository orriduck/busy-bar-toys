"""Agent task lifecycle registry. Agent apps translate their own records into it."""

from dataclasses import dataclass, replace
from datetime import datetime, timezone
import math
from pathlib import Path
import time

from . import profiles
from .tokens import TokenUsage

STALE_SECONDS = 1800
FLASH_SECONDS = 12
STATES = frozenset({"working", "waiting", "done", "error", "stopped", "unknown"})


def parse_timestamp(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return float(value) if math.isfinite(value) else None
        except OverflowError:
            return None
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.timestamp()
        except (ValueError, OverflowError):
            return None
    return None


@dataclass
class Task:
    session_id: str
    turn_id: str
    source: str
    project: str
    state: str
    started_at: float
    updated_at: float
    token_usage: TokenUsage | None = None


class TaskRegistry:
    def __init__(self):
        self._tasks: dict[str, Task] = {}
        self._metadata: dict[str, dict] = {}
        self._ignored: set[str] = set()
        self._seen_turns: dict[str, set[str]] = {}

    def task(self, session: str) -> Task | None:
        return self._tasks.get(session)

    def ignore(self, session: str):
        self._ignored.add(session)
        self._tasks.pop(session, None)

    def is_ignored(self, session: str) -> bool:
        return session in self._ignored

    def set_metadata(self, session: str, source: str, cwd, *, sticky=False):
        self._metadata[session] = {"source": source, "cwd": cwd, "sticky": sticky}
        current = self._tasks.get(session)
        if current:
            self._tasks[session] = replace(current, source=source, project=self._project(cwd))

    def ingest(self, record: dict, now: float | None = None) -> bool:
        """Apply one normalized lifecycle event; return whether a state was applied."""
        if not isinstance(record, dict):
            return False
        session = record.get("session_id")
        if not isinstance(session, str) or not session or session in self._ignored:
            return False
        return self._apply(session, record.get("state"), record, now)

    def _apply(self, session, state, record, now, *, payload=None, event_time=None,
               started_at=None, default_source=""):
        payload = payload or {}
        if not isinstance(state, str) or state not in STATES:
            return False
        current = self._tasks.get(session)
        timestamp = parse_timestamp(record.get("timestamp"))
        if timestamp is None:
            timestamp = parse_timestamp(event_time)
        if timestamp is None:
            if event_time is not None or record.get("timestamp") is not None:
                return False
            timestamp = time.time() if now is None else now
        if current and timestamp < current.updated_at:
            return False
        turn = record.get("turn_id") or payload.get("turn_id") or (current.turn_id if current else "")
        if not isinstance(turn, str):
            return False
        if current and turn != current.turn_id:
            if state not in {"working", "waiting"} or turn in self._seen_turns.get(session, set()):
                return False
        meta = self._metadata.get(session, {})
        source = record.get("source")
        if not (isinstance(source, str) and source in profiles.sources()):
            source = meta.get("source", default_source)
        if meta.get("sticky"):
            source = meta["source"]
        cwd = record.get("cwd") or meta.get("cwd")
        project = self._project(cwd) if cwd else (current.project if current else "")
        started = current.started_at if current and current.turn_id == turn else timestamp
        if started_at is not None:
            started = started_at
        self._tasks[session] = Task(session, turn, source, project, state, started, timestamp,
                                    current.token_usage if current and current.turn_id == turn else None)
        self._seen_turns.setdefault(session, set()).add(turn)
        return True

    @staticmethod
    def _project(cwd):
        return Path(cwd).name if isinstance(cwd, str) and cwd else ""

    def _visible(self, task: Task, now: float) -> Task | None:
        age = max(0, now - task.updated_at)
        if task.state in {"working", "waiting"}:
            if age <= STALE_SECONDS:
                return task
            if age <= STALE_SECONDS + FLASH_SECONDS:
                return replace(task, state="unknown")
        elif age <= FLASH_SECONDS:
            return task
        return None

    def visible_tasks(self, now: float) -> list[Task]:
        return [candidate for task in self._tasks.values() if (candidate := self._visible(task, now))]

    def select(self, now: float) -> Task | None:
        visible = self.visible_tasks(now)
        priority = {"waiting": 5, "working": 4, "error": 3, "unknown": 2, "done": 1, "stopped": 1}
        return max(visible, key=lambda task: (priority[task.state], task.updated_at), default=None)

    def active_turns(self, now: float) -> frozenset[tuple[str, str]]:
        return frozenset((task.session_id,task.turn_id) for task in self._tasks.values()
                         if task.state in {"working","waiting"} and now-task.updated_at <= STALE_SECONDS)

    def known_turns(self) -> frozenset[tuple[str, str]]:
        """Return every observed turn, including stale turns that may heartbeat later."""
        return frozenset((session,turn) for session,turns in self._seen_turns.items()
                         if session not in self._ignored for turn in turns)

    def active_count(self, now: float) -> int:
        return sum(task.state in {"working", "waiting"} and now - task.updated_at <= STALE_SECONDS for task in self._tasks.values())
