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

    def test_input_counts_fresh_and_cache_writes_but_not_cache_reads(self):
        self.write(json.dumps({"type": "user", "message": {"content": "usage assistant"}}),
                   assistant("m1", fresh=2, read=400, created=100, out=10),
                   assistant("m1", fresh=2, read=400, created=100, out=30),
                   assistant("m2", fresh=1, read=500, out=5))
        self.assertEqual(self.reader(str(self.path)), TokenUsage(103, 35))

    def test_reference_example_and_cache_read_growth_do_not_change_input(self):
        self.write(assistant("m1", fresh=20, created=30, read=900, out=7))
        self.assertEqual(self.reader(str(self.path)), TokenUsage(50, 7))
        other = TranscriptUsage(self.root); path = self.root / "other.jsonl"
        path.write_text(assistant("m1", fresh=20, created=30, read=5, out=7) + "\n")
        self.assertEqual(other(str(path)), TokenUsage(50, 7), "Same new input, different cache read")
        self.write(assistant("m2", fresh=10, read=950, out=1))
        self.assertEqual(self.reader(str(self.path)), TokenUsage(60, 8), "Growing cache reads add nothing")

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
        self.write(assistant("m1", read=999, created=999, out=1))
        registry = TaskRegistry()
        with patch("busybar_agents.profiles.profile") as profile:
            profile.return_value.usage_reader = self.reader
            registry.ingest({"session_id": "s", "turn_id": "t", "source": "claude", "state": "working",
                             "timestamp": 100, "transcript": str(self.path)}, 100)
            registry.refresh_usage(101)
        self.assertEqual(registry.task("s").token_usage, TokenUsage(1000, 1))
        self.assertEqual(registry.task("s").updated_at, 100, "Usage refresh is not activity")


    def test_non_object_and_malformed_lines_are_ignored_and_later_lines_still_count(self):
        self.write('["usage", "assistant"]', '"usage assistant"', '{"usage": "assistant"', "[[[" * 10 + '"usage" "assistant"',
                   json.dumps({"type": "assistant", "message": ["usage"]}),
                   json.dumps({"type": "assistant", "message": {"id": "m0", "usage": "assistant"}}),
                   assistant("m1", read=9, out=2))
        self.assertEqual(self.reader(str(self.path)), TokenUsage(1, 2))

    def registry(self):
        from unittest.mock import patch
        registry = TaskRegistry()
        patcher = patch("busybar_agents.profiles.profile")
        profile = patcher.start(); self.addCleanup(patcher.stop)
        profile.return_value.usage_reader = self.reader
        registry.ingest({"session_id": "s", "turn_id": "t", "source": "claude", "state": "working",
                         "timestamp": 100, "transcript": str(self.path)}, 100)
        return registry, profile

    def test_unavailable_reader_shows_unknown_and_recovery_has_no_fake_delta(self):
        from unittest.mock import patch
        from busybar_agents.tokens import TokenRateMeter, task_usage
        clock = [0.0]
        with patch("busybar_agents.tokens.METER", TokenRateMeter(clock=lambda: clock[0])):
            self.write(assistant("m1", fresh=10, out=20))
            registry, _ = self.registry()
            registry.refresh_usage(101)
            self.assertEqual(registry.task("s").token_usage, TokenUsage(10, 20))
            self.path.unlink()
            clock[0] = 1; registry.refresh_usage(102)
            self.assertIsNone(registry.task("s").token_usage)
            self.assertIsNone(task_usage(registry.task("s")), "Unavailable is unknown, not idle")
            self.write(assistant("m2", fresh=5000, out=900))
            clock[0] = 2; registry.refresh_usage(103)
            self.assertIsNone(task_usage(registry.task("s")), "Recovery warms up instead of inventing a delta")

    def test_a_failing_reader_does_not_stop_observation(self):
        registry, profile = self.registry()
        profile.return_value.usage_reader = lambda ref: (_ for _ in ()).throw(RuntimeError("broken source"))
        registry.refresh_usage(101)
        self.assertIsNone(registry.task("s").token_usage)

    def test_sessions_are_sampled_while_off_screen_so_switching_back_shows_the_last_window(self):
        from unittest.mock import patch
        from busybar_agents.tokens import TokenRateMeter, task_usage
        clock = [0.0]
        with patch("busybar_agents.tokens.METER", TokenRateMeter(window=10, clock=lambda: clock[0])):
            registry, _ = self.registry()
            for t in range(0, 101):
                clock[0] = t
                with open(self.path, "a") as stream:
                    stream.write(assistant(f"m{t}", fresh=0 if t < 90 else 100, out=0) + "\n")
                registry.refresh_usage(100 + t)
            self.assertEqual(task_usage(registry.task("s")), TokenUsage(100, 0),
                             "Only the last 10 seconds count, though the task was never rendered")

    def test_only_live_sessions_are_read_sampled_and_retained(self):
        from unittest.mock import patch
        from busybar_agents.events import FLASH_SECONDS
        from busybar_agents.tokens import TokenRateMeter
        clock = [0.0]
        meter = TokenRateMeter(clock=lambda: clock[0])
        reads = []
        self.write(assistant("m1", out=1))
        with patch("busybar_agents.tokens.METER", meter):
            registry, profile = self.registry()
            profile.return_value.usage_reader = lambda ref: reads.append(ref) or TokenUsage(5, 5)
            for i in range(100):
                registry.ingest({"session_id": f"done{i}", "turn_id": "t", "source": "chatgpt", "state": "done", "timestamp": 100}, 100)
                registry.set_usage(f"done{i}", TokenUsage(1000, 100))
            registry.ingest({"session_id": "busy", "turn_id": "t", "source": "chatgpt", "state": "working", "timestamp": 1990}, 1990)
            registry.set_usage("busy", TokenUsage(10, 10))
            registry.ingest({"session_id": "s", "turn_id": "t", "source": "claude", "state": "done",
                             "timestamp": 1995, "transcript": str(self.path)}, 1995)
            registry.refresh_usage(2000)
            self.assertEqual(set(meter._samples), {"busy", "s"}, "Ended sessions are not sampled; off-screen and flashing ones are")
            self.assertEqual(len(reads), 1)
            clock[0] = 1
            registry.refresh_usage(1995 + FLASH_SECONDS + 1)
            self.assertEqual(set(meter._samples), {"busy"}, "The flash grace ends, so its samples are released")
            self.assertEqual(len(reads), 1, "An ended session's reader is no longer polled")
            self.assertEqual(sum(len(v) for v in meter._samples.values()), 2)
        self.assertIsNotNone(registry.task("done0"), "Turn history is kept")
        self.assertIn(("done0", "t"), registry.known_turns())

if __name__ == "__main__":
    unittest.main()
