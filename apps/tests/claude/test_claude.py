import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from busybar_apps import load_agents
from busybar_agents import profiles
from busybar_agents.display import render
from busybar_agents.events import Task
from busybar_agents.runtime import hook_event, read_spool, write_event
from busybar_service.cli import main

load_agents()


def payload(event, **fields):
    return {"session_id": "claude-session", "hook_event_name": event, "cwd": "/work/busy", **fields}


class ClaudeProfileTest(unittest.TestCase):
    def test_profiles_resolve_sources_aliases_and_default(self):
        self.assertEqual(profiles.profile("claude").title, "Claude")
        self.assertEqual(profiles.profile("codex").source, "chatgpt")
        self.assertEqual(profiles.profile(None).source, "chatgpt")
        self.assertLessEqual({"chatgpt", "codex", "dots", "claude"}, profiles.sources())

    def test_hook_states(self):
        cases = [("UserPromptSubmit", {}, "working"), ("PreToolUse", {}, "working"),
                 ("PostToolUse", {}, "working"), ("Stop", {}, "done"), ("SessionEnd", {}, "stopped"),
                 ("Notification", {"notification_type": "permission_prompt"}, "waiting"),
                 ("Notification", {"notification_type": "idle_prompt"}, None),
                 ("Notification", {"message": "Claude needs your permission to use Bash"}, "waiting"),
                 ("Notification", {"message": "Claude is waiting for your input"}, None),
                 ("SubagentStop", {}, None)]
        for event, fields, state in cases:
            with self.subTest(event=event, fields=fields):
                result = hook_event(payload(event, **fields), now=100, source="claude")
                self.assertEqual(result and result["state"], state)

    def test_prompt_starts_a_local_turn_and_later_events_reuse_it(self):
        first = hook_event(payload("UserPromptSubmit"), now=100, source="claude")
        self.assertEqual(first["turn_id"], "local-100000")
        tool = hook_event(payload("PreToolUse"), now=101, source="claude", previous_turn=first["turn_id"])
        self.assertEqual(tool["turn_id"], first["turn_id"])
        second = hook_event(payload("UserPromptSubmit"), now=200, source="claude", previous_turn=first["turn_id"])
        self.assertNotEqual(second["turn_id"], first["turn_id"])

    def test_codex_hooks_keep_their_turn_identifiers(self):
        event = hook_event({"session_id": "s", "hook_event_name": "Stop", "turn_id": "t1"}, now=1, source="chatgpt")
        self.assertEqual(event["turn_id"], "t1")
        self.assertEqual(hook_event({"session_id": "s", "hook_event_name": "Stop"}, now=1)["turn_id"], "")

    def test_hook_command_reuses_the_spooled_turn(self):
        with tempfile.TemporaryDirectory() as root, patch("busybar_service.cli.SPOOL", Path(root)):
            for event in ("UserPromptSubmit", "PreToolUse", "Stop"):
                stdin = io.TextIOWrapper(io.BytesIO(json.dumps(payload(event)).encode()))
                with patch("sys.stdin", stdin):
                    self.assertEqual(main(["hook", "--source", "claude"]), 0)
                events = list(read_spool(Path(root)))
                self.assertEqual(len(events), 1)
                if event == "UserPromptSubmit":
                    turn = events[0]["turn_id"]
                self.assertEqual(events[0]["turn_id"], turn)
            self.assertEqual(events[0]["state"], "done")
            self.assertEqual(events[0]["source"], "claude")

    def test_spool_accepts_claude_and_rejects_unknown_sources(self):
        with tempfile.TemporaryDirectory() as root:
            now = 1000
            write_event(root, {"session_id": "a", "turn_id": "t", "state": "working", "source": "claude", "timestamp": now})
            write_event(root, {"session_id": "b", "turn_id": "t", "state": "working", "source": "nobody", "timestamp": now})
            self.assertEqual([e["session_id"] for e in read_spool(root, now=now)], ["a"])

    def test_display_uses_the_claude_icon_and_title(self):
        icon = profiles.profile("claude").icon(14)
        self.assertEqual(icon.size, (14, 14))
        self.assertTrue(icon.getbbox())
        self.assertNotEqual(icon.tobytes(), profiles.profile("chatgpt").icon(14).tobytes())
        task = Task("s", "t", "claude", "busy", "working", 0, 0)
        front, back = render(task, 0)
        codex_front, codex_back = render(Task("s", "t", "chatgpt", "busy", "working", 0, 0), 0)
        self.assertNotEqual(front.tobytes(), codex_front.tobytes())
        self.assertNotEqual(back.tobytes(), codex_back.tobytes())


if __name__ == "__main__":
    unittest.main()
