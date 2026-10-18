"""Bounded background AppKit samples. Application inventory never leaves the Mac."""
import json
from pathlib import Path
import subprocess
import threading
import time

HELPER = Path(__file__).resolve().parents[3]/'.venv/bin/busy-running-apps'


def sample(identifiers, helper=HELPER):
    try:
        result = subprocess.run([str(helper), *sorted(set(identifiers))],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3, check=True)
        if len(result.stdout) > 65536: return None
        value = json.loads(result.stdout)
        return value if isinstance(value, dict) else None
    except (OSError, subprocess.SubprocessError, ValueError, RecursionError):
        return None


class RunningApps:
    def __init__(self, identifiers, *, fetch=None, clock=time.monotonic):
        self.identifiers = tuple(identifiers)
        self.fetch, self.clock = fetch or sample, clock
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._latest = None
        self._thread = None
        self._sequence = 0

    def start(self):
        if self._thread is not None: return
        self._thread = threading.Thread(target=self._run, name='busy-running-apps', daemon=True)
        self._thread.start()

    def _run(self):
        while not self._stop.is_set():
            value = self.fetch(self.identifiers)
            with self._lock:
                self._sequence += 1
                self._latest = (self._sequence, self.clock(), value)
            self._stop.wait(2)

    def latest(self):
        with self._lock: return self._latest

    def stop(self):
        self._stop.set()
        if self._thread: self._thread.join(timeout=4)
