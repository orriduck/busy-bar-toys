import json
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid as uuidlib

from busybar_apps import load_agents
from busybar_apps.claude.usage import CHUNK, TranscriptUsage
from busybar_agents.events import FLASH_SECONDS, TaskRegistry
from busybar_agents.runtime import hook_event, read_spool, write_event
from busybar_agents.tokens import TokenUsage, task_usage


def stamp(seconds):
    return datetime.fromtimestamp(1_800_000_000 + seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Transcript:
    """Synthetic records shaped like Claude Code transcripts; no real content."""

    def __init__(self, path, *, spaced=False):
        self.path = path
        self.last = None
        self.spaced = spaced

    def _write(self, record):
        record.setdefault("uuid", str(uuidlib.uuid4()))
        record["timestamp"] = stamp(record.pop("at"))
        if self.spaced:
            record = dict(reversed(list(record.items())), extra={"uuid": "nested", "timestamp": stamp(-999)})
        with open(self.path, "a") as stream:
            stream.write(json.dumps(record, separators=None if self.spaced else (",", ":")) + "\n")
        self.last = record["uuid"]
        return record["uuid"]

    def context(self, at, kind="attachment"):
        return self._write({"parentUuid": self.last, "isSidechain": False, "type": kind, "at": at,
                            "message": {"content": "usage assistant"}})

    def reply(self, message_id, start, rows, *, fresh=2, created=0, read=0, out=0, parent=None, sidechain=False,
              stop="end_turn", follow=True):
        """A reply whose context record is at `start`, one row per content block at `rows`, then a follower."""
        parent = parent if parent is not None else self.context(start)
        for at in rows:
            parent = self.row(message_id, at, parent=parent, fresh=fresh, created=created, read=read, out=out,
                              sidechain=sidechain, stop=stop)
        if follow:
            self.context(rows[-1] + 0.1)

    def row(self, message_id, at, *, parent=None, fresh=2, created=0, read=0, out=0, sidechain=False, stop="end_turn"):
        return self._write({"parentUuid": parent if parent is not None else self.last, "isSidechain": sidechain,
                            "type": "assistant", "at": at,
                            "message": {"id": message_id, "stop_reason": stop,
                                        "content": [{"type": "text", "text": "secret"}],
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
        self.reader = TranscriptUsage(self.root)
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

    def test_completion_needs_a_stop_reason_and_a_follower_not_a_timeout(self):
        self.assertIsNone(self.throughput(), "Missing file")
        self.transcript.context(0, "user")
        self.assertIsNone(self.throughput())
        self.transcript.reply("m1", 0, [9, 10], out=200, follow=False)
        self.assertIsNone(self.throughput(), "No follower yet: rows may still be arriving")
        self.transcript.context(30)
        self.assertEqual(self.throughput(), TokenUsage(0, 20))
        self.transcript.reply("m2", 30, [40], out=900, stop=None)
        self.assertEqual(self.throughput(), TokenUsage(0, 20), "A reply without stop_reason has not completed")

    def test_duplicate_rows_count_once_and_out_of_order_rows_extend_the_reply(self):
        self.transcript.reply("m1", 0, [8, 10, 9], out=100)
        self.transcript.reply("m1", 0, [10], out=100, parent=self.transcript.last)
        self.transcript.context(11)
        self.assertEqual(self.throughput(), TokenUsage(0, 10))

    def test_newest_completed_reply_without_usable_timing_is_unknown(self):
        self.transcript.reply("m1", 0, [10], out=100)
        self.assertEqual(self.throughput(), TokenUsage(0, 10))
        self.transcript.reply("orphan", 20, [25], out=50, parent="00000000-0000-0000-0000-000000000000")
        self.assertIsNone(self.throughput(), "Not the older reply's value")
        for name, start, rows in (("zero", 30, [30]), ("negative", 40, [35])):
            self.transcript.reply("ok-" + name, start - 9, [start - 5], out=40)
            self.assertEqual(self.throughput(), TokenUsage(0, 10))
            self.transcript.reply(name, start, rows, out=50)
            self.assertIsNone(self.throughput(), name)
        self.transcript.reply("ok", 50, [60], out=100)
        self.transcript.reply("bad-usage", 61, [70], out=-1)
        self.assertIsNone(self.throughput(), "Unusable usage is unknown")
        self.transcript.reply("ok2", 71, [81], out=100)
        self.transcript.reply("generating", 82, [90], out=999, stop=None, follow=False)
        self.assertEqual(self.throughput(), TokenUsage(0, 10), "Active generation keeps the last completed reply")

    def test_rows_arriving_across_polls_recompute_instead_of_freezing(self):
        self.transcript.context(0)
        context = self.transcript.last
        first = self.transcript.row("m", 30, parent=context, out=938, created=1000)
        self.assertIsNone(self.throughput(), "One row without a follower is not a completed reply")
        self.transcript._write({"parentUuid": first, "type": "progress", "at": 31})
        self.transcript._write({"parentUuid": first, "type": "attachment", "isSidechain": True, "at": 31.5})
        self.assertIsNone(self.throughput(), "Progress and child-agent records are not completion evidence")
        self.transcript.row("m", 37, parent=first, out=938, created=1000)
        self.transcript.context(38)
        self.assertEqual(self.throughput(), TokenUsage(27, 25), "Later rows extend the reply: 938/37, not 938/30")

    def test_tool_calls_complete_only_when_the_next_reply_begins(self):
        self.transcript.reply("m0", 0, [5], out=50)
        self.assertEqual(self.throughput(), TokenUsage(0, 10))
        self.transcript.context(10)
        first = self.transcript.row("m", 40, parent=self.transcript.last, out=900, stop="tool_use")
        self.transcript._write({"parentUuid": first, "type": "user", "at": 41, "message": {"content": "tool result"}})
        self.assertEqual(self.throughput(), TokenUsage(0, 10), "An early tool result on a non-last row is not final")
        self.transcript.row("m", 46, parent=first, out=900, stop="tool_use")
        self.transcript.context(47, "user")
        self.assertEqual(self.throughput(), TokenUsage(0, 10), "A tool reply waits for the next reply")
        self.transcript.row("next", 50, parent=self.transcript.last, out=1, stop=None)
        self.assertEqual(self.throughput(), TokenUsage(0, 25), "900 output over 36 s, once the next reply began")

    def test_newest_completed_reply_with_missing_fields_is_unknown_and_older_rows_cannot_replace_it(self):
        for name, damage in (("no-timestamp", lambda r: r.pop("timestamp")),
                             ("no-usage", lambda r: r["message"].pop("usage")),
                             ("null-usage", lambda r: r["message"].__setitem__("usage", None))):
            with self.subTest(name):
                path = self.root / f"{name}.jsonl"
                transcript = Transcript(path)
                transcript.reply("m1", 0, [10], out=100)
                transcript.context(30)
                record = {"parentUuid": transcript.last, "isSidechain": False, "type": "assistant",
                          "uuid": str(uuidlib.uuid4()), "timestamp": stamp(40),
                          "message": {"id": "m2", "stop_reason": "end_turn", "usage": {"input_tokens": 0, "output_tokens": 900}}}
                damage(record)
                transcript.raw(json.dumps(record, separators=(",", ":")) + "\n")
                transcript.last = record["uuid"]
                transcript.context(41, "user")
                self.assertIsNone(self.reader(str(path)).throughput)
        path = self.root / "late.jsonl"
        transcript = Transcript(path)
        transcript.reply("m1", 0, [10], out=100)
        early = transcript.last
        transcript.reply("m2", 20, [30], out=500)
        transcript.row("m1", 12, parent=early, out=100)
        transcript.context(31)
        self.assertEqual(self.reader(str(path)).throughput, TokenUsage(0, 50), "A late older row does not replace m2")

    def test_equivalent_serializations_and_nested_lookalikes(self):
        spaced = Transcript(self.root / "spaced.jsonl", spaced=True)
        spaced.reply("m1", 0, [30, 37], fresh=2, created=1000, out=938)
        self.assertEqual(self.reader(str(self.root / "spaced.jsonl")).throughput, TokenUsage(27, 25),
                         "Key order, whitespace and extra properties do not matter")
        lookalike = str(uuidlib.uuid4())
        self.transcript.raw(json.dumps({"type": "attachment", "content": {"uuid": lookalike, "timestamp": stamp(0)}}) + "\n")
        self.transcript.reply("m2", 0, [10], out=100, parent=lookalike)
        self.assertIsNone(self.throughput(), "A nested uuid/timestamp is not a record boundary")

    def test_reply_after_a_compaction_boundary_measures_from_its_own_context(self):
        self.transcript.reply("m1", 0, [10], out=100)
        self.transcript._write({"parentUuid": None, "type": "system", "subtype": "compact_boundary", "at": 50})
        self.transcript.context(80, "user")
        self.transcript.reply("m2", 90, [100], out=900)
        self.assertEqual(self.throughput(), TokenUsage(0, 90), "From its request context at 90, not the boundary at 50")

    def test_child_agent_rows_are_ignored(self):
        self.transcript.reply("m1", 0, [10], out=100)
        self.transcript.reply("child", 11, [12], out=9000, sidechain=True)
        self.transcript.context(13)
        self.assertEqual(self.throughput(), TokenUsage(0, 10))

    def test_reads_incrementally_and_waits_for_a_complete_line(self):
        self.transcript.reply("m1", 0, [10], out=100)
        self.assertEqual(self.throughput(), TokenUsage(0, 10))
        self.transcript.context(12)
        line = json.dumps({"parentUuid": self.transcript.last, "type": "assistant",
                           "message": {"id": "m2", "stop_reason": "end_turn", "usage": {"input_tokens": 0, "output_tokens": 80}},
                           "uuid": str(uuidlib.uuid4()), "timestamp": stamp(16)}, separators=(",", ":"))
        self.transcript.raw(line[:20])
        self.assertEqual(self.throughput(), TokenUsage(0, 10))
        self.transcript.raw(line[20:] + "\n")
        self.transcript.last = json.loads(line)["uuid"]
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
