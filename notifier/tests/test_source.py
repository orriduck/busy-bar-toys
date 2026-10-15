import json
from pathlib import Path
import tempfile
import unittest

from busybar_notifier.model import Notification
from busybar_notifier.queue import NotificationQueue
from busybar_notifier.seen import SeenStore
from busybar_notifier.source import Poller, Source


class SeenStoreTest(unittest.TestCase):
    def test_baseline_then_fresh_items_once_and_private_file(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "state" / "seen.json"
            store = SeenStore(path)
            self.assertEqual(store.fresh([1, 2], str), [])
            self.assertEqual(store.fresh([1, 2, 3], str), [3])
            self.assertEqual(store.fresh([3], str), [])
            self.assertEqual(SeenStore(path).fresh([3, 4], str), [4])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), ["1", "2", "3", "4"])


class PollerTest(unittest.TestCase):
    def setUp(self):
        self.now = [0.0]
        self.queue = NotificationQueue(clock=lambda: self.now[0])

    def poller(self, *sources):
        return Poller(sources, self.queue, clock=lambda: self.now[0], wall=lambda: 1000, spawn=lambda work: work())

    def test_state_failure_replaces_stale_items_and_recovers(self):
        fail = [False]
        def poll(now):
            if fail[0]:
                raise RuntimeError("Command failed\nError: authentication expired")
            return [Notification("page:1", "urgent", "datadog", "DATADOG", "PAGED!")]
        poller = self.poller(Source("pages", "datadog", 0, "state", poll))
        poller.run_due()
        self.assertEqual(self.queue.current()[0].id, "page:1")
        fail[0] = True
        poller.run_due()
        top = self.queue.current()[0]
        self.assertEqual((top.id, top.title, top.detail), ("failing:pages", "ERROR", "pages: Error: authentication expired"))
        fail[0] = False
        poller.run_due()
        self.assertEqual(self.queue.current()[0].id, "page:1")

    def test_interval_source_tag_and_shown_callback(self):
        calls, shown = [], []
        def poll(now):
            calls.append(now)
            return [Notification(f"e{len(calls)}", "info", "test", "TEST", "NEW")]
        poller = self.poller(Source("events", "test", 60, "event", poll, on_shown=shown.append))
        poller.run_due(); poller.run_due()
        self.assertEqual(calls, [1000])
        top = self.queue.current()[0]
        self.assertEqual(top.source, "events")
        poller.shown(top)
        self.assertEqual([n.id for n in shown], ["e1"])
        self.now[0] = 61
        poller.run_due()
        self.assertEqual(len(calls), 2)

    def test_running_source_is_not_started_twice(self):
        pending = []
        poller = Poller([Source("slow", "test", 0, "event", lambda now: [])], self.queue,
                        clock=lambda: self.now[0], spawn=pending.append)
        poller.run_due(); poller.run_due()
        self.assertEqual(len(pending), 1)
        pending[0]()
        poller.run_due()
        self.assertEqual(len(pending), 2)


if __name__ == "__main__":
    unittest.main()
