import json
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid as uuidlib

from busybar_apps import load_agents
from busybar_apps.claude.usage import CHUNK, SETTLE_SECONDS, TranscriptUsage
from busybar_agents.events import FLASH_SECONDS, TaskRegistry
from busybar_agents.runtime import hook_event, read_spool, write_event
from busybar_agents.tokens import TokenUsage, task_usage


def stamp(seconds):
    return datetime.fromtimestamp(1_800_000_000 + seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Transcript:
    """Synthetic records shaped like Claude Code transcripts; no real content."""

    def __init__(self, path):
        self.path = path
        self.last = None

    def _write(self, record):
        record.setdefault("uuid", str(uuidlib.uuid4()))
        record["timestamp"] = stamp(record.pop("at"))
        with open(self.path, "a") as stream:
            stream.write(json.dumps(record, separators=(",", ":")) + "\n")
        self.last = record["uuid"]
        return record["uuid"]

    def context(self, at, kind="attachment"):
        return self._write({"parentUuid": self.last, "isSidechain": False, "type": kind, "at": at,
                            "message": {"content": "usage assistant"}})

    def reply(self, message_id, start, rows, *, fresh=2, created=0, read=0, out=0, parent=None, sidechain=False):
        """A reply whose context record is at `start`, with one row per content block at `rows`."""
        parent = parent if parent is not None else self.context(start)
        for at in rows:
            parent = self._write({"parentUuid": parent, "isSidechain": sidechain, "type": "assistant", "at": at,
                                  "message": {"id": message_id, "content": [{"type": "text", "text": "secret"}],
                                              "usage": {"input_tokens": fresh, "cache_creation_input_tokens": created,
                                                        "cache_read_input_tokens": read, "output_tokens": out}}})

    def raw(self, text):
        with open(self.path, "a") as stream:
            stream.write(text)


class TranscriptUsageTest(unittest.TestCase):
    def setUp(self):
        load_agents()
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name) / "projects"
        self.root.mkdir()
        self.path = self.root / "session.jsonl"
        self.now = [1_800_000_000 + 10_000.0]
        self.reader = TranscriptUsage(self.root, clock=lambda: self.now[0])
        self.transcript = Transcript(self.path)

    def tearDown(self):
        self.directory.cleanup()

    def throughput(self):
        result = self.reader(str(self.path))
        return None if result is None else result.throughput

    def test_reference_reply_is_its_own_average_and_held_until_the_next(self):
        self.transcript.reply("m1", 0, [30, 35, 37], fresh=2, created=1000, read=900000, out=938)
        self.transcript.context(38, "user")
        self.assertEqual(self.throughput(), TokenUsage(27, 25), "938 output over 37 s is 25/s, not 93.8/s")
        self.transcript.context(40, "user")
        self.assertEqual(self.throughput(), TokenUsage(27, 25), "Generation in progress keeps the last reply")
        self.transcript.reply("m2", 41, [51], fresh=1, created=9, out=300)
        self.transcript.context(52)
        self.assertEqual(self.throughput(), TokenUsage(1, 30))

    def test_cache_reads_are_excluded_and_a_cache_write_burst_stays_with_its_reply(self):
        self.transcript.reply("m1", 0, [10], fresh=20, created=600000, read=5, out=100)
        self.transcript.context(11)
        self.assertEqual(self.throughput(), TokenUsage(60002, 10))
        self.transcript.reply("m2", 11, [21], fresh=20, created=30, read=900, out=100)
        self.transcript.context(22)
        self.assertEqual(self.throughput(), TokenUsage(5, 10), "The burst does not carry into the next reply")

    def test_no_completed_reply_is_unknown_and_the_last_reply_settles_without_a_follower(self):
        self.assertIsNone(self.throughput(), "Missing file")
        self.transcript.context(0, "user")
        self.assertIsNone(self.throughput())
        self.transcript.reply("m1", 0, [9, 10], out=200)
        self.now[0] = 1_800_000_000 + 10 + SETTLE_SECONDS - 1
        self.assertIsNone(self.throughput(), "Rows may still be arriving")
        self.now[0] = 1_800_000_000 + 10 + SETTLE_SECONDS
        self.assertEqual(self.throughput(), TokenUsage(0, 20))

    def test_duplicate_rows_count_once_and_out_of_order_rows_extend_the_reply(self):
        self.transcript.reply("m1", 0, [8, 10, 9], out=100)
        self.transcript.reply("m1", 0, [10], out=100, parent=self.transcript.last)
        self.transcript.context(11)
        self.assertEqual(self.throughput(), TokenUsage(0, 10))

    def test_invalid_durations_and_missing_starts_keep_the_previous_value(self):
        self.transcript.reply("m1", 0, [10], out=100)
        self.transcript.context(11)
        good = self.throughput()
        self.transcript.reply("zero", 20, [20], out=50)
        self.transcript.reply("negative", 30, [25], out=50)
        self.transcript.reply("orphan", 40, [45], out=50, parent="00000000-0000-0000-0000-000000000000")
        self.transcript.context(46)
        self.assertEqual(self.throughput(), good)
        self.assertEqual(good, TokenUsage(0, 10))

    def test_resume_after_compaction_without_a_known_start_is_skipped(self):
        self.transcript.reply("m1", 0, [10], out=100)
        boundary = str(uuidlib.uuid4())
        self.transcript.raw(json.dumps({"type": "system", "subtype": "compact_boundary", "uuid": boundary,
                                        "content": "x", "timestamp": stamp(50)}) + "\n")
        self.transcript.reply("m2", 60, [70], out=900, parent=boundary)
        self.transcript.context(71)
        self.assertEqual(self.throughput(), TokenUsage(0, 10), "A start outside the visible records is not invented")

    def test_child_agent_rows_are_ignored(self):
        self.transcript.reply("m1", 0, [10], out=100)
        self.transcript.reply("child", 11, [12], out=9000, sidechain=True)
        self.transcript.context(13)
        self.assertEqual(self.throughput(), TokenUsage(0, 10))

    def test_reads_incrementally_and_waits_for_a_complete_line(self):
        self.transcript.reply("m1", 0, [10], out=100)
        self.transcript.context(11)
        self.assertEqual(self.throughput(), TokenUsage(0, 10))
        self.transcript.context(12)
        line = json.dumps({"parentUuid": self.transcript.last, "type": "assistant",
                           "message": {"id": "m2", "usage": {"input_tokens": 0, "output_tokens": 80}},
                           "uuid": str(uuidlib.uuid4()), "timestamp": stamp(16)}, separators=(",", ":"))
        self.transcript.raw(line[:20])
        self.assertEqual(self.throughput(), TokenUsage(0, 10))
        self.transcript.raw(line[20:] + "\n")
        self.transcript.context(17)
        self.assertEqual(self.throughput(), TokenUsage(0, 20))

    def test_non_object_malformed_and_oversized_lines_are_ignored(self):
        self.transcript.raw("\n".join(['["usage", "assistant"]', '"usage assistant"', '{"usage": "assistant"',
                                       "[[[" * 10 + '"usage" "assistant"',
                                       json.dumps({"type": "assistant", "message": ["usage"]}),
                                       json.dumps({"type": "assistant", "message": {"id": "m0", "usage": "assistant"}}),
                                       "x" * (CHUNK * 2 + 7)]) + "\n")
        self.transcript.reply("m1", 0, [10], out=100)
        self.transcript.context(11)
        self.assertEqual(self.throughput(), TokenUsage(0, 10))

    def test_rewritten_file_restarts_and_outside_paths_are_refused(self):
        self.transcript.reply("m1", 0, [10], out=100)
        self.transcript.context(11)
        self.throughput()
        self.path.unlink()
        self.transcript.context(20, "user")
        self.assertIsNone(self.throughput(), "A counter reset forgets the old reply")
        outside = Path(self.directory.name) / "other.jsonl"
        outside.write_text("{}\n")
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

    def registry(self, state="working"):
        registry = TaskRegistry()
        patcher = patch("busybar_agents.profiles.profile")
        profile = patcher.start(); self.addCleanup(patcher.stop)
        profile.return_value.usage_reader = lambda ref: self.reader(ref)
        registry.ingest({"session_id": "s", "turn_id": "t", "source": "claude", "state": state,
                         "timestamp": 100, "transcript": str(self.path)}, 100)
        return registry, profile

    def test_registry_shows_the_reply_throughput_and_lifecycle_clears_it(self):
        registry, _ = self.registry()
        registry.refresh_usage(101)
        self.assertIsNone(task_usage(registry.task("s")), "Initially unknown")
        self.transcript.reply("m1", 0, [10], out=100)
        self.transcript.context(11)
        registry.refresh_usage(102)
        self.assertEqual(task_usage(registry.task("s")), TokenUsage(0, 10))
        self.assertEqual(registry.task("s").updated_at, 100, "Usage refresh is not activity")
        registry.ingest({"session_id": "s", "turn_id": "t", "source": "claude", "state": "stopped", "timestamp": 103}, 103)
        self.assertIsNone(task_usage(registry.task("s")), "An ended session is unknown")
        self.path.unlink()
        registry.ingest({"session_id": "s", "turn_id": "t2", "source": "claude", "state": "working",
                         "timestamp": 104, "transcript": str(self.path)}, 104)
        registry.refresh_usage(105)
        self.assertIsNone(task_usage(registry.task("s")), "An unavailable transcript is unknown")

    def test_a_failing_reader_does_not_stop_observation(self):
        registry, profile = self.registry()
        profile.return_value.usage_reader = lambda ref: (_ for _ in ()).throw(RuntimeError("broken source"))
        registry.refresh_usage(101)
        self.assertIsNone(task_usage(registry.task("s")))

    def test_sessions_are_independent(self):
        other = Transcript(self.root / "other.jsonl")
        self.transcript.reply("m1", 0, [10], out=100); self.transcript.context(11)
        other.reply("m1", 0, [10], out=500); other.context(11)
        self.assertEqual(self.throughput(), TokenUsage(0, 10))
        self.assertEqual(self.reader(str(self.root / "other.jsonl")).throughput, TokenUsage(0, 50))

    def test_only_live_sessions_are_read(self):
        reads = []
        registry, profile = self.registry(state="done")
        profile.return_value.usage_reader = lambda ref: reads.append(ref) or self.reader(ref)
        registry.refresh_usage(100 + FLASH_SECONDS - 1)
        self.assertEqual(len(reads), 1, "Read during the completion flash")
        registry.refresh_usage(100 + FLASH_SECONDS + 1)
        self.assertEqual(len(reads), 1, "An ended session's reader is no longer polled")
        self.assertIsNotNone(registry.task("s"), "Turn history is kept")


if __name__ == "__main__":
    unittest.main()
