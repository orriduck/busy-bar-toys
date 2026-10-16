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
from busybar_shared.api import APIError, ConnectionError
from busybar_shared.lease import PATH


class SharedDisplayTests(unittest.TestCase):
    def run_host(self, item, *, other_until, until=40, enabled=True, takeover_at=None, buttons=(), read_error_at=None):
        clock = {"now": 0.0}
        files = {PATH: json.dumps({"host": "other-mac", "level": "info", "until": other_until}).encode()}
        api = Mock()
        draws = []
        api.draw.side_effect = lambda data: draws.append((clock["now"], data)) or True
        def read_file(path):
            if read_error_at is not None and clock['now'] >= read_error_at:
                raise ConnectionError('storage unavailable')
            if path not in files:raise APIError('missing',http_status=400)
            return files[path]
        api.read_file.side_effect = read_file
        api.write_file.side_effect = lambda path, data: files.__setitem__(path, data)
        registry = TaskRegistry()
        registry.ingest({"session_id": "s", "turn_id": "t", "timestamp": 0, "state": "working", "source": "chatgpt"}, 0)
        given = []
        source = Source("test", "test", 1, "event", lambda now: [] if given else (given.append(1) or [item]))
        presses = list(buttons)
        def pressed():
            if presses and clock['now'] >= presses[0]:
                presses.pop(0)
                return True
            return False

        def sleep(seconds):
            clock["now"] += seconds
            if takeover_at is not None and clock['now'] >= takeover_at:
                files[PATH] = json.dumps({'host': 'other-mac', 'level': 'urgent', 'until': 1000}).encode()
            if clock["now"] > until:
                raise KeyboardInterrupt

        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            patches = {"RUNTIME": Path(directory), "INBOX": Path(directory) / "inbox", "LOG": Mock(),
                       "read_token": Mock(return_value="test-only"), "BusyAPI": Mock(return_value=api),
                       "TaskRegistry": Mock(return_value=registry), "RolloutWatcher": Mock(dot_thread_ids=set()),
                       "configured_input_monitor": Mock(return_value=Mock(pop_start_pressed=Mock(side_effect=pressed))),
                       "configured_checker": Mock(return_value=None),
                       "load_dot_thread_ids": Mock(return_value=set()), "read_spool": Mock(return_value=[]),
                       "notifier_sources": Mock(return_value=[source] if enabled else []), "SPAWN": lambda work: work()}
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

    def test_agent_only_host_respects_foreign_lease_and_does_not_clear_it_on_exit(self):
        draws, api = self.run_host(None, enabled=False, other_until=1000, until=4)
        self.assertEqual(len(draws), 0)
        api.clear.assert_not_called()

    def test_shutdown_does_not_clear_a_display_taken_since_the_last_draw(self):
        draws, api = self.run_host(None, enabled=False, other_until=-1, takeover_at=2, until=4)
        self.assertTrue(draws)
        api.clear.assert_not_called()

    def test_button_cannot_run_the_old_hosts_action_after_takeover(self):
        action = Mock()
        item = Notification('old-page', 'urgent', 'test', 'TEST', 'PAGED', primary=action)
        self.run_host(item, other_until=-1, takeover_at=2, buttons=(2.55,), until=4)
        action.assert_not_called()

    def test_failed_primary_remains_visible_and_can_be_retried(self):
        action = Mock(side_effect=RuntimeError('ack rejected'))
        item = Notification('page', 'urgent', 'test', 'TEST', 'PAGED', primary=action)
        self.run_host(item, other_until=-1, buttons=(2,3), until=4)
        self.assertEqual(action.call_count, 2)

    def test_successful_primary_is_dismissed_once(self):
        action = Mock()
        item = Notification('page', 'urgent', 'test', 'TEST', 'PAGED', primary=action)
        self.run_host(item, other_until=-1, buttons=(2,3), until=4)
        action.assert_called_once()

    def test_unverifiable_owner_cannot_act_or_clear_on_shutdown(self):
        action=Mock()
        item=Notification('page','urgent','test','TEST','PAGED',primary=action)
        _,api=self.run_host(item,other_until=-1,read_error_at=2,buttons=(2.55,),until=4)
        action.assert_not_called()
        api.clear.assert_not_called()


if __name__ == "__main__":
    unittest.main()
