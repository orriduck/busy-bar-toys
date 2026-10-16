import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock

from busybar_service.cli import watch


class LocalDisplayTest(unittest.TestCase):
    def setUp(self):
        # Scope fixture clocks to the observer and its motion controller.
        # Patching time.time on the stdlib module also changes logging's clock
        # on Python 3.10 and consumes these finite per-iteration sequences.
        clock=SimpleNamespace(time=time.time,monotonic=time.monotonic,sleep=time.sleep)
        for target in ('busybar_service.cli.time','busybar_agents.motion.time'):
            clock_patch=patch(target,clock)
            clock_patch.start()
            self.addCleanup(clock_patch.stop)
        # These fixtures advance wall time once per watch iteration. Lease I/O
        # has independent clock reads and is covered by test_shared_display.
        lease=Mock()
        lease.foreign.return_value=None
        patcher=patch('busybar_service.cli.DisplayLease',return_value=lease)
        patcher.start()
        self.addCleanup(patcher.stop)


class IdleWatchTests(LocalDisplayTest):
    def test_observer_keeps_clock_and_unknown_tokens_with_no_network_sampling(self):
        with tempfile.TemporaryDirectory() as directory:
            api=Mock()
            with patch('busybar_service.cli.RUNTIME',Path(directory)), \
                 patch('busybar_service.cli.read_token',return_value='test-only'), \
                 patch('busybar_service.cli.BusyAPI',return_value=api), \
                 patch('busybar_service.cli.RolloutWatcher'), \
                 patch('busybar_service.cli.configured_input_monitor') as monitor, \
                 patch('busybar_agents.network.NetworkSampler',side_effect=AssertionError('network sampling is forbidden')) as sampler, \
                 patch('busybar_service.cli.load_dot_thread_ids',return_value=set()), \
                 patch('busybar_service.cli.read_spool',return_value=[]), \
                 patch('busybar_service.cli.time.sleep',side_effect=KeyboardInterrupt), \
                 patch('busybar_service.cli.signal.signal'):
                monitor.return_value.pop_start_pressed.return_value=False
                with self.assertRaises(KeyboardInterrupt):
                    watch(SimpleNamespace(dot_thread=[],reduced_motion=True))
            self.assertEqual(api.draw.call_count,1)
            payload=api.draw.call_args.args[0]
            self.assertEqual(payload['application_name'],'ai-status')
            self.assertTrue(all(e['type']!='animation' for e in payload['elements']))
            api.clear.assert_called_once()


if __name__=='__main__': unittest.main()

class ButtonWatchTests(LocalDisplayTest):
    def test_start_blocks_stale_turn_heartbeat_until_a_new_turn(self):
        from busybar_apps.codex.records import CodexTaskRegistry as TaskRegistry
        registry=TaskRegistry()
        registry.ingest({'session_id':'one','turn_id':'old','state':'working','timestamp':100})
        def poll(now):
            if now==2001:
                registry.ingest({'session_id':'one','timestamp':now,'type':'event_msg','payload':{'type':'token_count'}})
            elif now==2002:
                registry.ingest({'session_id':'one','turn_id':'new','state':'working','timestamp':now})
        with tempfile.TemporaryDirectory() as directory:
            api=Mock()
            watcher=Mock();watcher.poll.side_effect=poll
            with patch('busybar_service.cli.RUNTIME',Path(directory)), \
                 patch('busybar_service.cli.read_token',return_value='test-only'), \
                 patch('busybar_service.cli.BusyAPI',return_value=api), \
                 patch('busybar_service.cli.TaskRegistry',return_value=registry), \
                 patch('busybar_service.cli.RolloutWatcher',return_value=watcher), \
                 patch('busybar_service.cli.configured_input_monitor') as monitor, \
                 patch('busybar_agents.network.NetworkSampler',side_effect=AssertionError('network sampling is forbidden')) as sampler, \
                 patch('busybar_service.cli.load_dot_thread_ids',return_value=set()), \
                 patch('busybar_service.cli.read_spool',return_value=[]), \
                 patch('busybar_service.cli.time.time',side_effect=[100,2000,2001,2002]), \
                 patch('busybar_service.cli.time.sleep',side_effect=[None,None,None,KeyboardInterrupt]), \
                 patch('busybar_service.cli.signal.signal'):
                watcher.dot_thread_ids=set()
                monitor.return_value.pop_start_pressed.side_effect=[False,True,False,False]
                with self.assertRaises(KeyboardInterrupt):
                    watch(SimpleNamespace(dot_thread=[],reduced_motion=True))
            self.assertEqual(api.draw.call_count,2)
            self.assertEqual(api.clear.call_count,2)

    def test_start_holds_native_calendar_through_old_turn_updates_and_resumes_new_turn(self):
        from busybar_apps.codex.records import CodexTaskRegistry as TaskRegistry
        registry=TaskRegistry()
        poll_count=0
        def poll(now):
            nonlocal poll_count
            turn='new' if poll_count==3 else 'old'
            state='waiting' if poll_count==2 else 'working'
            registry.ingest({'session_id':'one','turn_id':turn,'state':state,'timestamp':now},now)
            poll_count+=1
        with tempfile.TemporaryDirectory() as directory:
            api=Mock()
            watcher=Mock();watcher.poll.side_effect=poll
            with patch('busybar_service.cli.RUNTIME',Path(directory)), \
                 patch('busybar_service.cli.read_token',return_value='test-only'), \
                 patch('busybar_service.cli.BusyAPI',return_value=api), \
                 patch('busybar_service.cli.TaskRegistry',return_value=registry), \
                 patch('busybar_service.cli.RolloutWatcher',return_value=watcher), \
                 patch('busybar_service.cli.configured_input_monitor',create=True) as monitor, \
                 patch('busybar_agents.network.NetworkSampler',side_effect=AssertionError('network sampling is forbidden')) as sampler, \
                 patch('busybar_service.cli.load_dot_thread_ids',return_value=set()), \
                 patch('busybar_service.cli.read_spool',return_value=[]), \
                 patch('busybar_service.cli.time.time',side_effect=[100,101,102,103]), \
                 patch('busybar_service.cli.time.sleep',side_effect=[None,None,None,KeyboardInterrupt]), \
                 patch('busybar_service.cli.signal.signal'):
                watcher.dot_thread_ids=set()
                monitor.return_value.pop_start_pressed.side_effect=[False,True,False,False]
                with self.assertRaises(KeyboardInterrupt):
                    watch(SimpleNamespace(dot_thread=[],reduced_motion=True))
            self.assertEqual(api.draw.call_count,2)
            self.assertEqual(api.clear.call_count,2)
            monitor.return_value.start.assert_called_once()
            monitor.return_value.stop.assert_called_once()

class StandbyWatchTests(LocalDisplayTest):
    def test_ten_second_standby_returns_calendar_without_refresh_reset_and_next_turn_resumes(self):
        from busybar_apps.codex.records import CodexTaskRegistry as TaskRegistry
        registry=TaskRegistry()
        times=iter([100,101,107,110.999,111,116,117])
        current={'now':100}
        def wall_time():
            current['now']=next(times)
            return current['now']
        def poll(now):
            if now in (100,101,117):
                registry.ingest({'session_id':'one','turn_id':'new' if now==117 else 'old',
                                 'state':'done' if now==101 else 'working','timestamp':now},now)
        with tempfile.TemporaryDirectory() as directory:
            api=Mock();draws=[];clears=[]
            api.draw.side_effect=lambda payload:draws.append(current['now']) or True
            api.clear.side_effect=lambda:clears.append(current['now'])
            watcher=Mock();watcher.poll.side_effect=poll
            with patch('busybar_service.cli.RUNTIME',Path(directory)), \
                 patch('busybar_service.cli.read_token',return_value='test-only'), \
                 patch('busybar_service.cli.BusyAPI',return_value=api), \
                 patch('busybar_service.cli.TaskRegistry',return_value=registry), \
                 patch('busybar_service.cli.RolloutWatcher',return_value=watcher), \
                 patch('busybar_service.cli.configured_input_monitor') as monitor, \
                 patch('busybar_agents.network.NetworkSampler',side_effect=AssertionError('network sampling is forbidden')) as sampler, \
                 patch('busybar_service.cli.load_dot_thread_ids',return_value=set()), \
                 patch('busybar_service.cli.read_spool',return_value=[]), \
                 patch('busybar_service.cli.time.time',side_effect=wall_time), \
                 patch('busybar_service.cli.time.monotonic',side_effect=lambda:current['now']), \
                 patch('busybar_service.cli.time.sleep',side_effect=[None]*6+[KeyboardInterrupt]), \
                 patch('busybar_service.cli.signal.signal'):
                watcher.dot_thread_ids=set()
                monitor.return_value.pop_start_pressed.return_value=False
                with self.assertRaises(KeyboardInterrupt):
                    watch(SimpleNamespace(dot_thread=[],reduced_motion=True))
            self.assertEqual(draws,[100,101,107,117])
            self.assertEqual(clears,[111,117])

class MotionWatchTests(LocalDisplayTest):
    def test_real_motion_controller_keeps_timer_and_next_turn_semantics(self):
        from busybar_apps.codex.records import CodexTaskRegistry as TaskRegistry
        registry=TaskRegistry();current={'now':100}
        times=iter([100,100.5,101,101.3,101.6,111.59,111.61,111.9,112,113])
        def wall_time():
            current['now']=next(times);return current['now']
        def poll(now):
            if now in (100,101,113):
                registry.ingest({'session_id':'one','turn_id':'new' if now==113 else 'old',
                                 'state':'done' if now==101 else 'working','timestamp':now},now)
        with tempfile.TemporaryDirectory() as directory:
            api=Mock();draws=[];clears=[]
            api.draw.side_effect=lambda payload:draws.append((current['now'],payload)) or True
            api.clear.side_effect=lambda:clears.append(current['now'])
            watcher=Mock();watcher.poll.side_effect=poll
            with patch('busybar_service.cli.RUNTIME',Path(directory)), \
                 patch('busybar_service.cli.read_token',return_value='test-only'), \
                 patch('busybar_service.cli.BusyAPI',return_value=api), \
                 patch('busybar_service.cli.TaskRegistry',return_value=registry), \
                 patch('busybar_service.cli.RolloutWatcher',return_value=watcher), \
                 patch('busybar_service.cli.configured_input_monitor') as monitor, \
                 patch('busybar_agents.network.NetworkSampler',side_effect=AssertionError('network sampling is forbidden')) as sampler, \
                 patch('busybar_service.cli.load_dot_thread_ids',return_value=set()), \
                 patch('busybar_service.cli.read_spool',return_value=[]), \
                 patch('busybar_service.cli.time.time',side_effect=wall_time), \
                 patch('busybar_service.cli.time.monotonic',side_effect=lambda:current['now']), \
                 patch('busybar_service.cli.time.sleep',side_effect=[None]*9+[KeyboardInterrupt]), \
                 patch('busybar_service.cli.signal.signal'):
                watcher.dot_thread_ids=set()
                monitor.return_value.pop_start_pressed.return_value=False
                with self.assertRaises(KeyboardInterrupt):watch(SimpleNamespace(dot_thread=[]))
            self.assertEqual(clears,[111.9,113])
            sampler.assert_not_called()
            self.assertTrue(any(t==101 and [e['id'] for e in p['elements']]==['motion-bar']
                                for t,p in draws))
            self.assertTrue(any(t==113 and any(e['id']=='motion-view' for e in p['elements'])
                                for t,p in draws))

    def test_asset_auth_failure_stops_the_observer_without_a_retry(self):
        from busybar_shared.api import AuthError
        with tempfile.TemporaryDirectory() as directory:
            api=Mock();api.upload_asset.side_effect=AuthError('rejected')
            with patch('busybar_service.cli.RUNTIME',Path(directory)), \
                 patch('busybar_service.cli.read_token',return_value='test-only'), \
                 patch('busybar_service.cli.BusyAPI',return_value=api), \
                 patch('busybar_service.cli.RolloutWatcher'), \
                 patch('busybar_service.cli.configured_input_monitor') as monitor, \
                 patch('busybar_agents.network.NetworkSampler',side_effect=AssertionError('network sampling is forbidden')), \
                 patch('busybar_service.cli.load_dot_thread_ids',return_value=set()), \
                 patch('busybar_service.cli.read_spool',return_value=[]), \
                 patch('busybar_service.cli.signal.signal'), \
                 self.assertLogs('busy-bar',level='ERROR'):
                monitor.return_value.pop_start_pressed.return_value=False
                self.assertEqual(watch(SimpleNamespace(dot_thread=[])),0)
            self.assertEqual(api.upload_asset.call_count,1)
            api.draw.assert_not_called()
            monitor.return_value.stop.assert_called_once()


class WatchClockIsolationTests(unittest.TestCase):
    def test_logging_wall_clock_reads_do_not_consume_observer_fixture_ticks(self):
        import logging
        factory=logging.getLogRecordFactory()
        def record_with_wall_time(*args,**kwargs):
            # Python 3.10 logging reads time.time(); force that behavior on
            # newer interpreters too, where LogRecord uses time.time_ns().
            logging.time.time()
            return factory(*args,**kwargs)
        scenarios=unittest.TestSuite([
            ButtonWatchTests('test_start_blocks_stale_turn_heartbeat_until_a_new_turn'),
            ButtonWatchTests('test_start_holds_native_calendar_through_old_turn_updates_and_resumes_new_turn'),
            StandbyWatchTests('test_ten_second_standby_returns_calendar_without_refresh_reset_and_next_turn_resumes'),
            MotionWatchTests('test_real_motion_controller_keeps_timer_and_next_turn_semantics'),
        ])
        result=unittest.TestResult()
        with self.assertLogs('busy-bar',level='INFO'), patch('logging._logRecordFactory',side_effect=record_with_wall_time):
            scenarios.run(result)
        self.assertEqual(result.errors,[])
        self.assertEqual(result.failures,[])
