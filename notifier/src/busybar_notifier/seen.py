"""Remember alerted item identifiers across restarts; the first poll is a baseline."""
import json
import os
from pathlib import Path
import tempfile
import threading

LIMIT = 1000


class SeenStore:
    def __init__(self, path):
        self.path = Path(path)
        self._ids = None
        self._lock = threading.Lock()

    def fresh(self, items, key):
        with self._lock:
            baseline = False
            if self._ids is None:
                try:
                    saved = json.loads(self.path.read_text())
                    self._ids = dict.fromkeys(str(i) for i in saved) if isinstance(saved, list) else {}
                except (OSError, ValueError):
                    self._ids, baseline = {}, True
            fresh = [item for item in items if str(key(item)) not in self._ids]
            if fresh or baseline:
                for item in fresh:
                    self._ids[str(key(item))] = None
                self._save(list(self._ids)[-LIMIT:])
            return [] if baseline else fresh

    def _save(self, ids):
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".seen-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(ids, handle)
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
