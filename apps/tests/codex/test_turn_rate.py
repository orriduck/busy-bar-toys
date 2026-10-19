"""Synthetic public TokenUsageRecord fixtures; no private rollout access."""
import unittest
import json
import os
from pathlib import Path
import tempfile

from busybar_apps import load_agents
from busybar_apps.codex.records import CodexTaskRegistry, RolloutWatcher
from busybar_agents.tokens import TokenUsage

load_agents()


def event(kind, turn="t", stamp=100, **fields):
    return {"session_id": "s", "type": "event_msg", "timestamp": stamp,
            "payload": {"type": kind, "turn_id": turn, **fields}}


def usage(turn="t", stamp=110, output=938, response="response-1", **fields):
    return {"session_id": "s", "type": "token_usage_record", "timestamp": stamp,
            "payload": {"thread_id": "s", "session_id": "root-session", "turn_id": turn,
                        "response_id": response,
                        "turn_token_usage": {"input_tokens": 1000, "cached_input_tokens": 200,
                                             "output_tokens": output, "reasoning_output_tokens": 900},
                        "thread_token_usage": {"input_tokens": 9000, "output_tokens": 9000}, **fields}}


class TurnRateTests(unittest.TestCase):
    def setUp(self):
        self.registry = CodexTaskRegistry()
        self.registry.ingest(event("task_started", started_at=100))

    def finish(self, **fields):
        self.registry.ingest(event("task_complete", stamp=137, duration_ms=37000, **fields))
        return self.registry.task("s").token_rate

    def test_attributed_turn_average_uses_monotonic_duration_and_counts_reasoning_once(self):
        self.registry.ingest(usage())
        # Wall-clock difference deliberately differs from the source's duration.
        self.registry.ingest(event("task_complete", stamp=150, duration_ms=37000))
        self.assertEqual(self.registry.task("s").token_rate, TokenUsage(21, 25))

    def test_multiple_responses_use_latest_turn_snapshot_not_last_response_or_thread_total(self):
        self.registry.ingest(usage(output=400))
        self.registry.ingest(usage(stamp=120, response="response-2", usage={"output_tokens": 538}))
        self.assertEqual(self.finish(), TokenUsage(21, 25))

    def test_replayed_usage_and_completion_do_not_double_count_or_clear_rate(self):
        self.registry.ingest(usage())
        self.assertFalse(self.registry.ingest(usage(stamp=120)))
        self.assertEqual(self.registry.task("s").updated_at, 110)
        expected = self.finish()
        self.registry.ingest(event("task_complete", stamp=138))
        self.assertEqual(self.registry.task("s").token_rate, expected)

    def test_out_of_order_or_wrong_attribution_does_not_corrupt_candidate(self):
        self.registry.ingest(usage())
        self.assertFalse(self.registry.ingest(usage(stamp=109, output=100)))
        self.assertFalse(self.registry.ingest(usage(turn="old", output=99999)))
        self.assertFalse(self.registry.ingest(usage(thread_id="different", output=99999)))
        self.assertEqual(self.finish(), TokenUsage(21, 25))

    def test_missing_or_nonpositive_or_noninteger_duration_is_unknown(self):
        for duration in (None, 0, -1, True, 37.0, "37000", float("inf")):
            with self.subTest(duration=duration):
                self.setUp()
                self.registry.ingest(usage())
                self.registry.ingest(event("task_complete", stamp=137, duration_ms=duration))
                self.assertIsNone(self.registry.task("s").token_rate)

    def test_no_usage_never_uses_clock_delta_or_old_token_count(self):
        self.registry.ingest(event("token_count", stamp=110,
                                   info={"total_token_usage": {"input_tokens": 1000, "output_tokens": 938},
                                         "last_token_usage": {"input_tokens": 1000, "output_tokens": 938}}))
        self.assertIsNone(self.finish())

    def test_missing_usage_timestamp_and_changed_session_epoch_are_unknown(self):
        for record in (usage(stamp=None, response="response-2"),
                       usage(stamp=120, session_id="different-root-session", response="response-2")):
            with self.subTest(record=record):
                self.setUp()
                self.registry.ingest(usage())
                self.registry.ingest(record)
                self.assertIsNone(self.finish())

    def test_same_response_and_counts_cannot_bypass_session_epoch_validation(self):
        for epoch in ("changed-root", None, "", [], 42):
            with self.subTest(epoch=epoch):
                self.setUp()
                self.registry.ingest(usage())
                self.registry.ingest(usage(stamp=120, session_id=epoch))
                self.assertIsNone(self.finish())
        self.setUp()
        self.registry.ingest(usage())
        replay = usage(stamp=120)
        del replay["payload"]["session_id"]
        self.registry.ingest(replay)
        self.assertIsNone(self.finish())

    def test_same_response_replay_with_malformed_timestamp_clears_candidate(self):
        for stamp in (None, True, float("nan"), float("inf"), "bad", {}, 10**400):
            with self.subTest(stamp=stamp):
                self.setUp()
                self.registry.ingest(usage())
                self.assertFalse(self.registry.ingest(usage(stamp=stamp)))
                self.assertIsNone(self.finish())

    def test_completion_requires_explicit_matching_turn_and_integer_duration_without_replay_revival(self):
        for duration in (False, {}, [], 37000.0, "37000"):
            with self.subTest(duration=duration):
                self.setUp()
                self.registry.ingest(usage())
                self.registry.ingest(event("task_complete", stamp=137, duration_ms=duration))
                self.assertIsNone(self.registry.task("s").token_rate)
                self.registry.ingest(event("task_complete", stamp=138, duration_ms=37000))
                self.assertIsNone(self.registry.task("s").token_rate)
        self.setUp()
        self.registry.ingest(usage())
        completion = event("task_complete", stamp=137, duration_ms=37000)
        del completion["payload"]["turn_id"]
        self.registry.ingest(completion)
        self.assertIsNone(self.registry.task("s").token_rate)

    def test_new_turn_holds_previous_average_until_completion_then_clears_unknown(self):
        self.registry.ingest(usage())
        previous = self.finish()
        self.registry.ingest(event("task_started", turn="new", stamp=140))
        self.assertEqual(self.registry.task("s").token_rate, previous)
        self.registry.ingest(event("task_complete", turn="new", stamp=141, duration_ms=1000))
        self.assertIsNone(self.registry.task("s").token_rate)
        self.assertFalse(self.registry.ingest(usage(turn="new", stamp=142)))
        self.assertIsNone(self.registry.task("s").token_rate)

    def test_reset_or_conflicting_response_or_invalid_new_usage_invalidates_whole_turn(self):
        for record in (usage(stamp=120, output=100, response="response-2"),
                       usage(stamp=120, output=999),
                       usage(stamp=120, turn_token_usage={"input_tokens": 1, "output_tokens": True}),
                       usage(stamp=120, response_id=None)):
            with self.subTest(record=record):
                self.setUp()
                self.registry.ingest(usage())
                self.registry.ingest(record)
                self.registry.ingest(usage(stamp=125, output=1200, response="response-3"))
                self.assertIsNone(self.finish())

    def test_interrupted_or_failed_turn_is_unknown(self):
        for kind in ("turn_aborted", "error"):
            with self.subTest(kind=kind):
                self.setUp()
                self.registry.ingest(usage())
                self.registry.ingest(event(kind, stamp=137, duration_ms=37000))
                self.assertIsNone(self.registry.task("s").token_rate)
        self.setUp()
        self.registry.ingest(usage())
        self.assertIsNone(self.finish(error={"message": "synthetic failure"}))

    def test_terminal_abort_clears_a_previously_completed_same_turn_average(self):
        self.registry.ingest(usage())
        self.assertIsNotNone(self.finish())
        self.registry.ingest(event("turn_aborted", stamp=138))
        self.assertIsNone(self.registry.task("s").token_rate)

    def test_zero_tokens_is_measured_zero_and_new_turn_snapshot_cannot_leak(self):
        self.registry.ingest(usage(output=0, turn_token_usage={"input_tokens": 0, "output_tokens": 0}))
        self.assertEqual(self.finish(), TokenUsage(0, 0))
        self.registry.ingest(event("task_started", turn="new", stamp=140))
        self.registry.ingest(usage(turn="t", stamp=141))
        self.registry.ingest(event("task_complete", turn="new", stamp=142, duration_ms=1000))
        self.assertIsNone(self.registry.task("s").token_rate)

    def test_forked_parent_usage_is_not_assigned_to_child_thread(self):
        self.registry.ingest(usage(thread_id="parent"))
        self.assertIsNone(self.finish())

    def test_explicit_turn_snapshot_survives_compaction_without_inventing_a_total_delta(self):
        self.registry.ingest(usage(output=400))
        self.registry.ingest({"session_id": "s", "type": "compacted", "timestamp": 115,
                              "payload": {"latest_token_usage_record": usage()["payload"]}})
        self.registry.ingest(usage(stamp=120, response="response-2"))
        self.assertEqual(self.finish(), TokenUsage(21, 25))


class TurnWatcherTests(unittest.TestCase):
    def test_existing_watcher_consumes_attributed_synthetic_records_and_cleans_temporary_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.jsonl"
            records = [{"type": "session_meta", "payload": {"id": "s"}},
                       event("task_started"), usage(),
                       event("task_complete", stamp=137, duration_ms=37000)]
            path.write_text("".join(json.dumps(record) + "\n" for record in records))
            os.utime(path, (137, 137))
            registry = CodexTaskRegistry()
            watcher = RolloutWatcher(Path(directory), registry)
            self.assertEqual(watcher.poll(138), 3)
            self.assertEqual(registry.task("s").token_rate, TokenUsage(21, 25))
            self.assertEqual(watcher.poll(139), 0)
        self.assertFalse(path.exists())

    def test_bounded_tail_missing_usage_is_unknown_even_with_valid_completion_duration(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.jsonl"
            records = [{"type": "session_meta", "payload": {"id": "s"}},
                       event("task_started"), usage()]
            path.write_text("".join(json.dumps(record) + "\n" for record in records)
                            + "x" * (1024 * 1024 + 100) + "\n"
                            + json.dumps(event("task_complete", stamp=137, duration_ms=37000)) + "\n")
            os.utime(path, (137, 137))
            registry = CodexTaskRegistry()
            RolloutWatcher(Path(directory), registry).poll(138)
            self.assertIsNone(registry.task("s").token_rate)


if __name__ == "__main__":
    unittest.main()
