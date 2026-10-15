"""Run the production observer with real presenters, a synchronous poller, and a fake clock."""
from contextlib import ExitStack
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from busybar_service.cli import watch
from busybar_apps.adsbao.commands import mock_aircraft
from busybar_apps.adsbao.display import ENTRANCE_SECONDS, HOLD_SECONDS
from busybar_apps.codex.records import CodexTaskRegistry as TaskRegistry
from busybar_shared.api import ConnectionError


class AircraftWatchTests(unittest.TestCase):
    def scenario(self, *, button_at=None, fail_after=None, until=130):
        clock = {"now": 100.0}
        registry = TaskRegistry()

        def poll(now):
            if now < 101 and not registry.task("one"):
                registry.ingest({"session_id": "one", "turn_id": "old", "timestamp": now, "state": "working"}, now)
            elif now >= 105 and registry.task("one").state == "working":
                registry.ingest({"session_id": "one", "turn_id": "old", "timestamp": now, "state": "waiting"}, now)

        api = Mock()
        draws, clears = [], []

        def draw(data):
            if fail_after is not None and clock["now"] >= fail_after:
                draws.append((clock["now"], None))
                raise ConnectionError("Unavailable")
            draws.append((clock["now"], data))
            return True

        api.draw.side_effect = draw
        api.clear.side_effect = lambda: clears.append(clock["now"])
        plane = mock_aircraft(100)
        checker = Mock()
        checker.poll.side_effect = lambda now: plane if not checker.mark_alerted.called else None
        watcher = Mock()
        watcher.poll.side_effect = poll
        watcher.dot_thread_ids = set()
        monitor = Mock()
        pressed = []
        monitor.pop_start_pressed.side_effect = lambda: (button_at is not None and clock["now"] >= button_at
                                                         and not pressed and not pressed.append(1))

        def sleep(seconds):
            clock["now"] += seconds
            if clock["now"] > until:
                raise KeyboardInterrupt

        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            patches = {"RUNTIME": Path(directory), "INBOX": Path(directory) / "inbox", "LOG": Mock(),
                       "read_token": Mock(return_value="test-only"), "BusyAPI": Mock(return_value=api),
                       "TaskRegistry": Mock(return_value=registry), "RolloutWatcher": Mock(return_value=watcher),
                       "configured_input_monitor": Mock(return_value=monitor),
                       "configured_checker": Mock(return_value=checker), "NetworkSampler": Mock(),
                       "load_dot_thread_ids": Mock(return_value=set()), "read_spool": Mock(return_value=[]),
                       "SPAWN": lambda work: work()}
            patches["NetworkSampler"].return_value.sample.return_value = None
            for name, value in patches.items():
                stack.enter_context(patch("busybar_service.cli." + name, value))
            stack.enter_context(patch("busybar_service.cli.time.time", side_effect=lambda: clock["now"]))
            stack.enter_context(patch("busybar_service.cli.time.monotonic", side_effect=lambda: clock["now"]))
            stack.enter_context(patch("busybar_service.cli.time.sleep", side_effect=sleep))
            stack.enter_context(patch("busybar_service.cli.signal.signal"))
            with self.assertRaises(KeyboardInterrupt):
                watch(SimpleNamespace(dot_thread=[]))
        checker.start.assert_called_once()
        checker.stop.assert_called_once()
        checker.mark_alerted.assert_called_once()
        return draws, clears

    @staticmethod
    def elements(payload):
        return {e["id"]: e for e in payload["elements"]} if payload else {}

    def test_aircraft_holds_then_restores_the_latest_agent_state(self):
        draws, _ = self.scenario(until=125)
        intro = [t for t, p in draws if self.elements(p).get("notice-view", {}).get("section") == "enter"]
        self.assertEqual(len(intro), 1, "The entrance plays once")
        fade = [t for t, p in draws if self.elements(p).get("motion-view", {}).get("path") == "notice-out.anim"]
        self.assertEqual(len(fade), 1)
        self.assertAlmostEqual(fade[0] - intro[0], ENTRANCE_SECONDS + HOLD_SECONDS, delta=.6)
        restored = [p for t, p in draws if t > fade[0] and "waiting" in str(self.elements(p).get("thinking", {}).get("path", ""))]
        self.assertTrue(restored, "The agent view returns with the state that changed during the alert")

    def test_button_dismisses_the_alert_returns_to_calendar_and_blocks_old_turn(self):
        draws, clears = self.scenario(button_at=103, until=125)
        fade = [t for t, p in draws if self.elements(p).get("motion-view", {}).get("path") == "notice-out.anim"]
        self.assertEqual(len(fade), 1)
        self.assertLess(fade[0], 104)
        self.assertTrue(clears and 103 <= clears[0] < 105, "The calendar returns right after the fade")
        self.assertFalse(any(t > fade[0] and "thinking" in self.elements(p) and
                             "notice" not in str(self.elements(p)) for t, p in draws),
                         "The old turn does not take the display back")

    def test_device_errors_back_off(self):
        draws, _ = self.scenario(fail_after=104, until=140)
        failures = [t for t, p in draws if p is None]
        self.assertGreaterEqual(len(failures), 2)
        gaps = [b - a for a, b in zip(failures, failures[1:])]
        self.assertTrue(all(gap >= 4.9 for gap in gaps), gaps)
        self.assertGreaterEqual(gaps[-1], gaps[0])


if __name__ == "__main__":
    unittest.main()
