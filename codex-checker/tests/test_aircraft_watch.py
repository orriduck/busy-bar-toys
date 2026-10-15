"""Run the production observer with real presenters and finite source fixtures."""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch
from contextlib import ExitStack
from busybar_status.cli import watch
from busybar_status.events import TaskRegistry
from adsbao_checker.commands import mock_aircraft


class AircraftWatchTests(unittest.TestCase):
    def scenario(self,button=False,fail_refresh=False):
        registry=TaskRegistry();current={'now':100}
        ticks=([100,105,105.25,105.5,110,110.25,111,115] if fail_refresh else
               [100,100.5,105,110.39,110.41,110.7,111.3,112])
        times=iter(ticks)
        def wall():current['now']=next(times);return current['now']
        def poll(now):
            if now in (100,105):
                registry.ingest({'session_id':'one','turn_id':'old','timestamp':now,
                                 'state':'working' if now==100 else 'waiting'},now)
        api=Mock();draws=[];clears=[]
        def draw(data):
            draws.append((current['now'],data))
            if fail_refresh and current['now']>=105:
                from busybar_shared.api import ConnectionError
                raise ConnectionError('Unavailable')
            return True
        api.draw.side_effect=draw
        api.clear.side_effect=lambda:clears.append(current['now'])
        source=Mock();source.poll.side_effect=lambda now:mock_aircraft(now) if now==100 else None
        watcher=Mock();watcher.poll.side_effect=poll;watcher.dot_thread_ids=set()
        monitor=Mock();monitor.pop_start_pressed.side_effect=lambda:button and current['now']==105
        with tempfile.TemporaryDirectory() as directory,ExitStack() as stack:
            patches={'RUNTIME':Path(directory),'read_token':Mock(return_value='test-only'),
                     'BusyAPI':Mock(return_value=api),'TaskRegistry':Mock(return_value=registry),
                     'RolloutWatcher':Mock(return_value=watcher),'configured_input_monitor':Mock(return_value=monitor),
                     'configured_checker':Mock(return_value=source),'NetworkSampler':Mock(),
                     'load_dot_thread_ids':Mock(return_value=set()),'read_spool':Mock(return_value=[])}
            patches['NetworkSampler'].return_value.sample.return_value=None
            for name,value in patches.items():stack.enter_context(patch('busybar_status.cli.'+name,value))
            stack.enter_context(patch('busybar_status.cli.time.time',side_effect=wall))
            stack.enter_context(patch('busybar_status.cli.time.monotonic',side_effect=lambda:current['now']))
            stack.enter_context(patch('busybar_status.cli.time.sleep',side_effect=[None]*7+[KeyboardInterrupt]))
            stack.enter_context(patch('busybar_status.cli.signal.signal'))
            with self.assertRaises(KeyboardInterrupt):watch(SimpleNamespace(dot_thread=[]))
        source.start.assert_called_once();source.stop.assert_called_once()
        source.mark_alerted.assert_called_once()
        return draws,clears

    def test_aircraft_restores_latest_codex_state_after_hold(self):
        draws,clears=self.scenario()
        bodies=[(t,p) for t,p in draws if any(e['id']=='thinking' for e in p['elements'])]
        self.assertTrue(any(t==100 and any(e['id']=='plane-view' for e in p['elements']) for t,p in bodies))
        restored=[(t,p) for t,p in bodies if t>110.5]
        self.assertTrue(restored)
        self.assertTrue(any('waiting' in e.get('path','') for e in restored[0][1]['elements']))
        self.assertEqual(clears,[112])

    def test_button_dismissal_returns_to_calendar_and_blocks_old_turn(self):
        draws,clears=self.scenario(button=True)
        self.assertEqual(clears,[110.39])
        self.assertFalse(any(t>100 and any(e['id']=='thinking' for e in p['elements']) for t,p in draws))

    def test_device_errors_gate_aircraft_refresh_and_all_other_display_work(self):
        with self.assertLogs('busy-bar',level='WARNING'):
            draws,clears=self.scenario(fail_refresh=True)
        self.assertEqual([t for t,p in draws],[100,105,110])
        self.assertEqual(clears,[115])
