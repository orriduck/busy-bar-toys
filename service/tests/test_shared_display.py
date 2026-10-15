"""Two hosts share one BUSY Bar through the display lease in device storage."""
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from busybar_service.cli import watch
from busybar_apps.codex.records import CodexTaskRegistry as TaskRegistry
from busybar_notifier.model import Notification
from busybar_notifier.source import Source
from busybar_shared.api import APIError
from busybar_shared.lease import PATH


class SharedDisplayTests(unittest.TestCase):
    def run_host(self, item, *, other_until, until=40):
        clock = {"now": 0.0}
        files = {PATH: json.dumps({"host": "other-mac", "level": "info", "until": other_until}).encode()}
        api = Mock()
        draws = []
        api.draw.side_effect = lambda data: draws.append((clock["now"], data)) or True
        api.read_file.side_effect = lambda path: files[path] if path in files else (_ for _ in ()).throw(APIError("missing"))
        api.write_file.side_effect = lambda path, data: files.__setitem__(path, data)
        registry = TaskRegistry()
        registry.ingest({"session_id": "s", "turn_id": "t", "timestamp": 0, "state": "working", "source": "chatgpt"}, 0)
        given = []
        source = Source("test", "test", 1, "event", lambda now: [] if given else (given.append(1) or [item]))

        def sleep(seconds):
            clock["now"] += seconds
            if clock["now"] > until:
                raise KeyboardInterrupt

        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            patches = {"RUNTIME": Path(directory), "INBOX": Path(directory) / "inbox", "LOG": Mock(),
                       "read_token": Mock(return_value="test-only"), "BusyAPI": Mock(return_value=api),
                       "TaskRegistry": Mock(return_value=registry), "RolloutWatcher": Mock(dot_thread_ids=set()),
                       "configured_input_monitor": Mock(return_value=Mock(pop_start_pressed=Mock(return_value=False))),
                       "configured_checker": Mock(return_value=None), "NetworkSampler": Mock(),
                       "load_dot_thread_ids": Mock(return_value=set()), "read_spool": Mock(return_value=[]),
                       "notifier_sources": Mock(return_value=[source]), "SPAWN": lambda work: work()}
            patches["NetworkSampler"].return_value.sample.return_value = None
            for name, value in patches.items():
                stack.enter_context(patch("busybar_service.cli." + name, value))
            stack.enter_context(patch("busybar_service.cli.time.time", side_effect=lambda: clock["now"]))
            stack.enter_context(patch("busybar_service.cli.time.monotonic", side_effect=lambda: clock["now"]))
            stack.enter_context(patch("busybar_service.cli.time.sleep", side_effect=sleep))
            stack.enter_context(patch("busybar_service.cli.signal.signal"))
            with self.assertRaises(KeyboardInterrupt):
                watch(SimpleNamespace(dot_thread=[]))
        return draws, api

    @staticmethod
    def started(draws):
        return [t for t, p in draws if any(e.get("section") == "enter" for e in p["elements"])]

    def test_info_waits_for_the_other_host_and_agent_view_pauses(self):
        item = Notification("n", "info", "test", "TEST", "NEW PR", "repo #1")
        draws, _ = self.run_host(item, other_until=20)
        starts = self.started(draws)
        self.assertEqual(len(starts), 1)
        self.assertGreaterEqual(starts[0], 20, "The notification waits until the other lease expires")
        self.assertFalse([t for t, p in draws if t < 20], "The agent view does not draw over the other host")

    def test_urgent_takes_the_display_at_once(self):
        item = Notification("p", "urgent", "datadog", "DATADOG", "PAGED!", "#1")
        draws, api = self.run_host(item, other_until=1000, until=10)
        starts = self.started(draws)
        self.assertTrue(starts and starts[0] < 2)
        lease = json.loads(api.write_file.call_args_list[0].args[1])
        self.assertEqual(lease["level"], "urgent")


if __name__ == "__main__":
    unittest.main()
