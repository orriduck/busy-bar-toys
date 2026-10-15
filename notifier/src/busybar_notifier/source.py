"""Run notification sources in background threads so slow commands never block drawing."""
from dataclasses import dataclass, replace
import logging
import threading
import time
from typing import Callable

from .model import Notification

LOG = logging.getLogger("busy-bar")


@dataclass
class Source:
    name: str
    app: str
    every: float
    kind: str
    poll: Callable[[float], list]
    icon: object = None
    on_shown: Callable[[Notification], None] | None = None
    start: Callable[[], None] | None = None
    stop: Callable[[], None] | None = None

    def __post_init__(self):
        if self.kind not in ("state", "event"):
            raise ValueError("A source kind is state or event.")


class Poller:
    def __init__(self, sources, queue, *, clock=None, wall=None, spawn=None):
        self.sources = list(sources)
        self.queue = queue
        self.clock = clock or time.monotonic
        self.wall = wall or time.time
        self._spawn = spawn or (lambda work: threading.Thread(target=work, daemon=True).start())
        self._last = {}
        self._running = set()
        self._errors = {}
        self._lock = threading.Lock()

    def start(self):
        for source in self.sources:
            if source.start:
                source.start()

    def stop(self):
        for source in self.sources:
            if source.stop:
                source.stop()

    def run_due(self):
        for source in self.sources:
            with self._lock:
                if source.name in self._running or self.clock() - self._last.get(source.name, -float("inf")) < source.every:
                    continue
                self._last[source.name] = self.clock()
                self._running.add(source.name)
            self._spawn(lambda source=source: self._run(source))

    def refresh(self, name):
        with self._lock:
            self._last.pop(name, None)

    def shown(self, item):
        source = next((s for s in self.sources if s.name == item.source), None)
        if source and source.on_shown:
            source.on_shown(item)

    def _run(self, source):
        try:
            items = [replace(item, source=source.name) for item in source.poll(self.wall())]
            self._errors.pop(source.name, None)
            if source.kind == "state":
                self.queue.set_state(source.name, items)
            elif items:
                self.queue.push(items)
                LOG.info("%s: %s", source.name, ", ".join(item.id for item in items))
        except Exception as error:  # A source failure must not stop the service.
            message = (str(error).strip().splitlines() or [type(error).__name__])[-1][:120]
            if self._errors.get(source.name) != message:
                LOG.warning("%s failed: %s", source.name, message)
            self._errors[source.name] = message
            if source.kind == "state":
                self.queue.set_state(source.name, [Notification(
                    f"failing:{source.name}", "attention", source.app, source.app.upper(), "ERROR",
                    f"{source.name}: {message}", icon=source.icon)])
        finally:
            with self._lock:
                self._running.discard(source.name)
