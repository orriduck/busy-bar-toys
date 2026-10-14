import json
import os
from pathlib import Path
import tempfile
import unittest

from busybar_status.events import TaskRegistry, RolloutWatcher, load_dot_thread_ids


def hook(session="s", turn="t", state="working", timestamp=100, **kwargs):
    return dict(session_id=session, turn_id=turn, source="chatgpt", cwd="/work/bar", state=state, timestamp=timestamp, **kwargs)


class RegistryTests(unittest.TestCase):
    def test_normalized_hook_and_priority(self):
        r = TaskRegistry()
        r.ingest(hook(), now=100)
        r.ingest(hook("waiting", state="waiting", timestamp=101), now=101)
        task = r.select(102)
        self.assertEqual((task.session_id, task.source, task.project, task.state), ("waiting", "chatgpt", "bar", "waiting"))
        self.assertEqual(r.active_count(102), 2)

    def test_completion_flash_and_stale_active(self):
        r = TaskRegistry()
        r.ingest(hook(), now=100)
        self.assertEqual(r.select(1901).state, "unknown")
        self.assertIsNone(r.select(1913))
        self.assertEqual(r.active_count(1901), 0)
        r.ingest(hook(state="done", timestamp=2000), now=2000)
        self.assertEqual(r.select(2011).state, "done")
        self.assertIsNone(r.select(2013))

    def test_old_turn_and_old_timestamp_cannot_clear_work(self):
        r = TaskRegistry()
        r.ingest(hook(turn="old"))
        r.ingest(hook(turn="new", timestamp=110))
        r.ingest(hook(turn="old", state="done", timestamp=120))
        r.ingest(hook(turn="new", state="done", timestamp=105))
        self.assertEqual((r.select(121).turn_id, r.select(121).state), ("new", "working"))

    def test_error_beats_done_but_not_work_and_tool_failure_is_ignored(self):
        r = TaskRegistry()
        r.ingest(hook("done", state="done"))
        r.ingest(hook("err", state="error"))
        self.assertEqual(r.select(101).state, "error")
        r.ingest(hook("work"))
        r.ingest({"session_id":"work", "timestamp":101, "type":"response_item", "payload":{"type":"function_call_output", "output":"Process exited with code 1"}})
        self.assertEqual(r.select(102).state, "working")

    def test_rollout_lifecycle_wait_and_continue(self):
        r = TaskRegistry()
        r.ingest({"type":"session_meta", "payload":{"id":"s", "cwd":"/work/repo", "originator":"orbit_cca"}})
        r.ingest({"session_id":"s", "timestamp":"2026-10-14T00:00:00Z", "type":"event_msg", "payload":{"type":"task_started", "turn_id":"turn"}})
        epoch = 1791936000
        self.assertEqual(r.select(epoch).source, "dots")
        r.ingest({"session_id":"s", "timestamp":epoch+1, "type":"response_item", "payload":{"type":"function_call", "name":"request_user_input_async", "arguments":"not retained"}})
        self.assertEqual(r.select(epoch+1).state, "waiting")
        r.ingest({"session_id":"s", "timestamp":epoch+2, "type":"response_item", "payload":{"type":"function_call_output", "output":"anything"}})
        self.assertEqual(r.select(epoch+2).state, "working")
        r.ingest({"session_id":"s", "type":"event_msg", "payload":{"type":"turn_aborted", "turn_id":"turn", "completed_at":epoch+3}})
        self.assertEqual(r.select(epoch+3).state, "stopped")
        self.assertEqual(set(vars(r.select(epoch+3))), {"session_id","turn_id","source","project","state","started_at","updated_at"})

    def test_subagent_ignored_and_metadata_recognizes_dot(self):
        r = TaskRegistry()
        r.ingest({"type":"session_meta", "payload":{"id":"s", "source":{"subagent":{"parent_thread_id":"p"}}}})
        r.ingest(hook())
        self.assertIsNone(r.select(100))
        r.ingest({"type":"session_meta", "payload":{"id":"dot", "responsesapi_client_metadata":{"aeon_kind":"orbit"}}})
        r.ingest({"session_id":"dot","turn_id":"t","type":"event_msg","payload":{"type":"task_started","started_at":100}})
        self.assertEqual(r.select(100).source,"dots")

    def test_malformed_records_are_ignored(self):
        r = TaskRegistry()
        for record in (None, [], {}, {"state":"working"}, hook(timestamp="bad"), hook(state="unrecognized")):
            r.ingest(record, now=100)
        self.assertIsNone(r.select(100))

    def test_waiting_can_recover_after_truncated_start_and_tool_prefix(self):
        r = TaskRegistry()
        r.ingest({"session_id":"s", "timestamp":100, "type":"response_item", "payload":{"type":"function_call", "name":"functions.request_user_input", "turn_id":"a"}})
        self.assertIsNotNone(r.select(100))
        self.assertEqual(r.select(100).state,"waiting")

    def test_heartbeat_keeps_active_without_creating_or_reviving_a_task(self):
        r = TaskRegistry()
        heartbeat = {"session_id":"s", "timestamp":1800, "type":"event_msg", "payload":{"type":"token_count"}}
        r.ingest(heartbeat)
        self.assertIsNone(r.select(1800))
        r.ingest(hook())
        r.ingest(heartbeat)
        self.assertEqual(r.select(1900).state,"working")
        self.assertEqual(r.select(1900).started_at,100)
        r.ingest(hook(state="done",timestamp=1901))
        heartbeat["timestamp"] = 1920
        r.ingest(heartbeat)
        self.assertIsNone(r.select(1920))

    def test_outer_timestamp_orders_completion_after_fractional_tool_output(self):
        r = TaskRegistry()
        r.ingest({"session_id":"s", "timestamp":100.25, "type":"event_msg", "payload":{"type":"task_started","turn_id":"a","started_at":99}})
        r.ingest({"session_id":"s", "timestamp":101.5, "type":"response_item", "payload":{"type":"function_call_output"}})
        r.ingest({"session_id":"s", "timestamp":101.75, "type":"event_msg", "payload":{"type":"task_complete","turn_id":"a","completed_at":101}})
        self.assertEqual(r.select(102).state,"done")
        self.assertEqual(r.select(102).started_at,99)
        self.assertEqual(r.select(102).updated_at,101.75)

    def test_zero_event_time_is_valid_and_nonfinite_timestamp_is_ignored(self):
        r = TaskRegistry()
        r.ingest({"session_id":"s","type":"event_msg","payload":{"type":"task_started","started_at":0}})
        self.assertEqual(r.select(1).started_at,0)
        for stamp in (float("inf"),float("nan"),10**400):
            r.ingest(hook(state="done",timestamp=stamp))
        self.assertEqual(r.select(1).state,"working")

    def test_unrelated_parallel_output_does_not_clear_waiting(self):
        r = TaskRegistry()
        r.ingest(hook())
        r.ingest({"session_id":"s","timestamp":101,"type":"response_item","payload":{"type":"function_call","name":"functions.request_user_input_async","call_id":"wait-1"}})
        r.ingest({"session_id":"s","timestamp":102,"type":"response_item","payload":{"type":"function_call_output","call_id":"parallel-2"}})
        self.assertEqual(r.select(102).state,"waiting")
        r.ingest({"session_id":"s","timestamp":103,"type":"response_item","payload":{"type":"function_call_output","call_id":"wait-1"}})
        self.assertEqual(r.select(103).state,"working")

    def test_unseen_turn_can_begin_as_waiting_after_spool_coalescing(self):
        r = TaskRegistry()
        r.ingest(hook(turn="old",state="done",timestamp=100))
        r.ingest(hook(turn="new",state="waiting",timestamp=101))
        self.assertEqual((r.select(102).turn_id,r.select(102).state),("new","waiting"))
        r.ingest(hook(turn="old",state="waiting",timestamp=103))
        self.assertEqual(r.select(104).turn_id,"new")

    def test_malformed_source_defaults_without_crashing(self):
        for source in ([], {}, 42, None):
            with self.subTest(source=source):
                r = TaskRegistry()
                record = hook()
                record["source"] = source
                r.ingest(record)
                self.assertEqual(r.select(100).source,"codex")

    def test_malformed_record_and_payload_types_do_not_crash_registry(self):
        r = TaskRegistry()
        r.ingest(hook())
        for malformed in ([], {}, 42):
            for outer in ("event_msg", "response_item", malformed):
                with self.subTest(outer=outer,payload_type=malformed):
                    r.ingest({"session_id":"s","timestamp":101,"type":outer,"payload":{"type":malformed}})
        self.assertEqual(r.select(102).state,"working")
        self.assertEqual(r.select(102).updated_at,100)


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.path = self.root / "2026/10/14/rollout-2026-10-14T00-00-00-12345678-1234-1234-1234-123456789abc.jsonl"
        self.path.parent.mkdir(parents=True)

    def write(self, records):
        self.path.write_text("".join(json.dumps(r)+"\n" for r in records))
        os.utime(self.path, (100,100))

    def test_replays_recent_events_with_metadata_and_reads_append_once(self):
        self.write([{"type":"session_meta","payload":{"id":"actual","cwd":"/work/demo"}}, {"timestamp":90,"type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}])
        r = TaskRegistry()
        w = RolloutWatcher(self.root, r, {"actual"})
        self.assertEqual(w.poll(100), 1)
        self.assertEqual((r.select(100).session_id,r.select(100).source), ("actual","dots"))
        self.assertEqual(w.poll(101),0)
        with self.path.open("a") as f:
            f.write("bad json\n" + json.dumps({"timestamp":102,"type":"event_msg","payload":{"type":"task_complete","turn_id":"a"}})+"\n")
        self.assertEqual(w.poll(102),1)
        self.assertEqual(r.select(102).state,"done")
        self.assertEqual(w.poll(103),0)

    def test_partial_line_waits_for_newline_and_applies_once(self):
        event = json.dumps({"timestamp":100,"type":"event_msg","payload":{"type":"task_started","turn_id":"a"}})
        self.path.write_text(event[:25])
        os.utime(self.path,(100,100))
        r = TaskRegistry()
        w = RolloutWatcher(self.root,r)
        self.assertEqual(w.poll(100),0)
        with self.path.open("a") as f:
            f.write(event[25:]+"\n")
        self.assertEqual(w.poll(101),1)
        self.assertEqual(r.select(101).session_id,"12345678-1234-1234-1234-123456789abc")
        self.assertEqual(w.poll(102),0)

    def test_ignores_old_files_old_events_and_subagents(self):
        self.write([{"type":"session_meta","payload":{"id":"s","source":{"subagent":{}}}}, {"timestamp":100,"type":"event_msg","payload":{"type":"task_started"}}])
        r = TaskRegistry()
        self.assertEqual(RolloutWatcher(self.root,r).poll(100),0)
        self.assertIsNone(r.select(100))
        self.write([{"timestamp":1,"type":"event_msg","payload":{"type":"task_started"}}])
        self.assertEqual(RolloutWatcher(self.root,TaskRegistry()).poll(2000),0)

    def test_large_initial_tail_preserves_metadata_and_ignores_truncated_json(self):
        self.path.write_text(json.dumps({"type":"session_meta","payload":{"id":"actual","source":{"subagent":{}}}})+"\n"+"x"*(1024*1024)+"\n"+json.dumps({"timestamp":100,"type":"event_msg","payload":{"type":"task_started"}})+"\n")
        os.utime(self.path,(100,100))
        r = TaskRegistry()
        self.assertEqual(RolloutWatcher(self.root,r).poll(100),0)
        self.assertIsNone(r.select(100))

    def test_tail_at_line_boundary_does_not_drop_first_complete_event(self):
        event = json.dumps({"timestamp":100,"type":"event_msg","payload":{"type":"task_started","turn_id":"a"}})+"\n"
        tail = event + (" "*(1024*1024-len(event)-1)) + "\n"
        self.path.write_text("prefix\n" + tail)
        os.utime(self.path,(100,100))
        r = TaskRegistry()
        self.assertEqual(RolloutWatcher(self.root,r).poll(100),1)
        self.assertEqual(r.select(100).state,"working")

    def test_replaced_or_truncated_file_can_be_replayed(self):
        self.write([{"timestamp":100,"type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}])
        r = TaskRegistry()
        w = RolloutWatcher(self.root,r)
        self.assertEqual(w.poll(100),1)
        self.path.unlink()
        self.write([{"timestamp":101,"type":"event_msg","payload":{"type":"task_complete","turn_id":"a"}}])
        self.assertEqual(w.poll(101),1)
        self.assertEqual(r.select(101).state,"done")

    def test_same_inode_rewrite_at_same_or_larger_size_is_replayed(self):
        for padding in (0, 100):
            with self.subTest(padding=padding):
                started = json.dumps({"timestamp":100,"type":"event_msg","payload":{"type":"task_started","turn_id":"a"}})+" \n"
                completed = json.dumps({"timestamp":101,"type":"event_msg","payload":{"type":"task_complete","turn_id":"a"}})+"\n"
                self.path.write_text(started)
                os.utime(self.path,(100,100))
                inode = self.path.stat().st_ino
                r = TaskRegistry()
                w = RolloutWatcher(self.root,r)
                self.assertEqual(w.poll(100),1)
                self.path.write_text(completed+" "*(len(started)-len(completed)+padding))
                os.utime(self.path,(101,101))
                self.assertEqual(self.path.stat().st_ino,inode)
                self.assertGreaterEqual(self.path.stat().st_size,len(started))
                self.assertEqual(w.poll(101),1)
                self.assertEqual(r.select(101).state,"done")
                self.assertEqual(w.poll(102),0)

    def test_in_place_rewrite_with_restored_mtime_is_replayed(self):
        started = json.dumps({"timestamp":100,"type":"event_msg","payload":{"type":"task_started","turn_id":"a"}})+" \n"
        completed = json.dumps({"timestamp":101,"type":"event_msg","payload":{"type":"task_complete","turn_id":"a"}})+"\n"
        self.path.write_text(started)
        os.utime(self.path,(100,100))
        r = TaskRegistry()
        w = RolloutWatcher(self.root,r)
        w.poll(100)
        self.path.write_text(completed+" "*(len(started)-len(completed)))
        os.utime(self.path,(100,100))
        self.assertEqual(w.poll(101),1)
        self.assertEqual(r.select(101).state,"done")

    def test_boot_recovers_long_turn_start_outside_tail_before_recent_heartbeat(self):
        records = [{"type":"session_meta","payload":{"id":"actual","cwd":"/work/long"}},
                   {"timestamp":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"long"}}]
        self.write(records)
        with self.path.open("a") as f:
            f.write("x"*(1024*1024+100)+"\n")
            f.write(json.dumps({"timestamp":4999,"type":"event_msg","payload":{"type":"token_count"}})+"\n")
        os.utime(self.path,(5000,5000))
        r = TaskRegistry()
        self.assertEqual(RolloutWatcher(self.root,r).poll(5000),2)
        self.assertEqual((r.select(5000).turn_id,r.select(5000).started_at),("long",1))
        self.assertEqual(r.active_count(5000),1)

    def test_boot_terminal_boundary_prevents_long_turn_heartbeat_revival(self):
        self.write([{"type":"session_meta","payload":{"id":"actual"}},
                    {"timestamp":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"long"}},
                    {"timestamp":2,"type":"event_msg","payload":{"type":"task_complete","turn_id":"long"}}])
        with self.path.open("a") as f:
            f.write("x"*(1024*1024+100)+"\n")
            f.write(json.dumps({"timestamp":4999,"type":"event_msg","payload":{"type":"token_count"}})+"\n")
        os.utime(self.path,(5000,5000))
        r = TaskRegistry()
        RolloutWatcher(self.root,r).poll(5000)
        self.assertIsNone(r.select(5000))
        self.assertEqual(r.active_count(5000),0)

    def test_boot_recovers_boundary_that_straddles_tail_cutoff(self):
        event = json.dumps({"timestamp":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"long"}})+"\n"
        heartbeat = json.dumps({"timestamp":4999,"type":"event_msg","payload":{"type":"token_count"}})+"\n"
        padding = "x"*(1024*1024-len(event)//2-len(heartbeat)-1)+"\n"
        self.path.write_text(json.dumps({"type":"session_meta","payload":{"id":"actual"}})+"\n"+event+padding+heartbeat)
        os.utime(self.path,(5000,5000))
        r = TaskRegistry()
        RolloutWatcher(self.root,r).poll(5000)
        self.assertIsNotNone(r.select(5000))
        self.assertEqual(r.select(5000).turn_id,"long")

    def test_boot_ignores_malformed_unhashable_state(self):
        self.write([{"timestamp":100,"state":[],"session_id":"s"}])
        self.assertEqual(RolloutWatcher(self.root,TaskRegistry()).poll(100),0)

    def test_boot_ignores_malformed_payload_types(self):
        self.write([{"timestamp":100,"type":"event_msg","payload":{"type":[]}},
                    {"timestamp":100,"type":"event_msg","payload":{"type":{}}},
                    {"timestamp":100,"type":[],"payload":{"type":[]}}])
        self.assertEqual(RolloutWatcher(self.root,TaskRegistry()).poll(100),0)


class DotCacheTests(unittest.TestCase):
    def test_only_explicit_orbit_profiles_are_whitelisted(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)/"state.json"
            path.write_text(json.dumps({"electron-persisted-atom-state":{
                "primary-aeon-selection-v1":{"response":{"selection":{"thread_id":"selected"},"profile":{"aeon_kind":"orbit"}}},
                "cloud-aeon-sidebar-cache-v1":{"profilesByThreadId":{"known":{"aeon_kind":"orbit","active_root_thread_id":"root"},"other":{"aeon_kind":"agent"}}},
            }}))
            self.assertEqual(load_dot_thread_ids(path),{"selected","known","root"})
            path.write_text("not json")
            self.assertEqual(load_dot_thread_ids(path),set())
            self.assertEqual(load_dot_thread_ids(Path(d)/"missing"),set())


if __name__ == "__main__":
    unittest.main()
