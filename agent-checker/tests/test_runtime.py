import json
from pathlib import Path
import tempfile
import unittest

from busybar_agents.runtime import hook_event, write_event, read_spool
from busybar_apps import load_agents

load_agents()


class RuntimeTests(unittest.TestCase):
    def test_hook_drops_prompts_and_tool_arguments(self):
        event = hook_event({"hook_event_name": "PermissionRequest", "session_id": "s",
                            "turn_id": "t", "cwd": "/work/project", "prompt": "secret",
                            "tool_input": {"token": "secret"}}, now=100)
        self.assertEqual(event["state"], "waiting")
        self.assertNotIn("secret", json.dumps(event))
        self.assertEqual(event["cwd"], "project")

    def test_spool_is_private_and_ignores_future_or_expired_events(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)/"events"
            write_event(root, {"session_id": "../../bad", "turn_id": "t", "state": "working",
                               "source": "dots", "timestamp": 100, "cwd": "project"})
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            self.assertEqual(len(list(root.glob("*.json"))), 1)
            self.assertEqual(len(list(read_spool(root, now=101))), 1)
            self.assertEqual(list(read_spool(root, now=10)), [])
            self.assertEqual(list(read_spool(root, now=2000)), [])

    def test_only_known_hook_events_produce_state(self):
        base = {"session_id": "s", "hook_event_name": "Stop"}
        self.assertEqual(hook_event(base, now=100)["state"], "done")
        self.assertIsNone(hook_event({**base, "hook_event_name": "Unrecognized"}, now=100))
        self.assertIsNone(hook_event({**base, "hook_event_name": []}, now=100))

    def test_malformed_spool_records_cannot_crash_the_observer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for i, malformed in enumerate([
                {"session_id": [], "state": "working", "timestamp": 100},
                {"session_id": "s", "state": {}, "timestamp": 100},
                {"session_id": "s", "state": "working", "source": [], "timestamp": 100},
                {"session_id": "s", "state": "working", "timestamp": True},
                {"session_id": "s", "state": "working", "timestamp": 10**400},
                ["unexpected"],
            ]):
                (root/f'{i}.json').write_text(json.dumps(malformed))
            self.assertEqual(list(read_spool(root, now=101)), [])


if __name__ == "__main__": unittest.main()
