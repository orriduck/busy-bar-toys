import json
from pathlib import Path
import tempfile
import unittest

from busybar_apps import load_agents
from busybar_apps.claude.usage import TranscriptUsage, CHUNK
from busybar_agents.events import TaskRegistry
from busybar_agents.runtime import hook_event, read_spool, write_event
from busybar_agents.tokens import TokenUsage


def assistant(message_id, *, fresh=1, read=0, created=0, out=0, text="secret reply"):
    return json.dumps({"type": "assistant", "message": {"id": message_id, "content": [{"type": "text", "text": text}],
                       "usage": {"input_tokens": fresh, "cache_read_input_tokens": read,
                                 "cache_creation_input_tokens": created, "output_tokens": out}}})


class TranscriptUsageTest(unittest.TestCase):
    def setUp(self):
        load_agents()
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name) / "projects"
        self.root.mkdir()
        self.path = self.root / "session.jsonl"
        self.reader = TranscriptUsage(self.root)

    def tearDown(self):
        self.directory.cleanup()

    def write(self, *lines, mode="a"):
        with open(self.path, mode) as stream:
            stream.write("".join(line + "\n" for line in lines))

    def test_input_includes_both_caches_and_repeated_message_lines_count_once(self):
        self.write(json.dumps({"type": "user", "message": {"content": "usage assistant"}}),
                   assistant("m1", fresh=2, read=400, created=100, out=10),
                   assistant("m1", fresh=2, read=400, created=100, out=30),
                   assistant("m2", fresh=1, read=500, out=5))
        self.assertEqual(self.reader(str(self.path)), TokenUsage(1003, 35))

    def test_reads_incrementally_and_waits_for_a_complete_line(self):
        self.write(assistant("m1", out=10))
        self.assertEqual(self.reader(str(self.path)), TokenUsage(1, 10))
        with open(self.path, "a") as stream:
            stream.write(assistant("m2", out=5)[:20])
        self.assertEqual(self.reader(str(self.path)), TokenUsage(1, 10))
        with open(self.path, "a") as stream:
            stream.write(assistant("m2", out=5)[20:] + "\n")
        self.assertEqual(self.reader(str(self.path)), TokenUsage(2, 15))

    def test_oversized_lines_are_skipped_without_stalling(self):
        self.write("x" * (CHUNK * 2 + 7), assistant("m1", out=3))
        self.assertEqual(self.reader(str(self.path)), TokenUsage(1, 3))

    def test_rewritten_file_restarts_and_outside_paths_are_refused(self):
        self.write(assistant("m1", out=50))
        self.reader(str(self.path))
        self.path.unlink(); self.write(assistant("m9", out=4))
        self.assertEqual(self.reader(str(self.path)), TokenUsage(1, 4))
        outside = Path(self.directory.name) / "other.jsonl"
        outside.write_text(assistant("m1", out=1) + "\n")
        self.assertIsNone(self.reader(str(outside)))
        self.assertIsNone(self.reader(str(self.root / "missing.jsonl")))

    def test_hook_carries_the_transcript_path_only_for_usage_aware_agents(self):
        payload = {"hook_event_name": "UserPromptSubmit", "session_id": "s", "cwd": "/tmp/p",
                   "transcript_path": str(self.path)}
        self.assertEqual(hook_event(payload, source="claude", now=100)["transcript"], str(self.path))
        self.assertNotIn("transcript", hook_event(payload, source="chatgpt", now=100))
        spool = Path(self.directory.name) / "spool"
        write_event(spool, hook_event(payload, source="claude", now=100))
        self.assertEqual([e.get("transcript") for e in read_spool(spool, now=101)], [str(self.path)])

    def test_registry_refreshes_totals_through_the_source_reader(self):
        from unittest.mock import patch
        self.write(assistant("m1", read=999, out=1))
        registry = TaskRegistry()
        with patch("busybar_agents.profiles.profile") as profile:
            profile.return_value.usage_reader = self.reader
            registry.ingest({"session_id": "s", "turn_id": "t", "source": "claude", "state": "working",
                             "timestamp": 100, "transcript": str(self.path)}, 100)
            registry.refresh_usage(101)
        self.assertEqual(registry.task("s").token_usage, TokenUsage(1000, 1))
        self.assertEqual(registry.task("s").updated_at, 100, "Usage refresh is not activity")


if __name__ == "__main__":
    unittest.main()
