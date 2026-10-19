from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from busybar_service import cloud_watch

class PreviewWatchTest(unittest.TestCase):
    def test_cloud_watch_owns_exactly_one_optional_bridge_and_stops_it(self):
        producer=Mock(snapshot={}); producer.config={'serviceId':'service'}
        notifier=Mock(snapshot={}); notifier.config={'serviceId':'notifier'}
        clients={'agent':producer,'notifier':notifier}
        monitor=Mock(); monitor.pop_start_pressed.return_value=False
        with tempfile.TemporaryDirectory() as runtime:
            with patch.object(cloud_watch,'producers',return_value=clients), \
                 patch.object(cloud_watch,'PreviewBridge',create=True) as bridge, \
                 patch.object(cloud_watch,'CodexTaskRegistry'), \
                 patch.object(cloud_watch,'RolloutWatcher'), \
                 patch.object(cloud_watch,'load_dot_thread_ids',return_value=set()), \
                 patch.object(cloud_watch,'AgentRenderer'), \
                 patch.object(cloud_watch,'AgentSignals') as agents, \
                 patch('busybar_agents.network.NetworkSampler',side_effect=AssertionError('network sampling is forbidden')) as sampler, \
                 patch.object(cloud_watch,'notifier_sources',return_value=[]), \
                 patch.object(cloud_watch,'configured_checker',return_value=None), \
                 patch.object(cloud_watch,'ViewMode') as view, \
                 patch.object(cloud_watch,'read_spool',return_value=[]), \
                 patch.object(cloud_watch,'InputMonitor',return_value=monitor), \
                 patch.object(cloud_watch.time,'sleep',side_effect=KeyboardInterrupt):
                view.return_value.allows.return_value=True
                with self.assertRaises(KeyboardInterrupt):
                    cloud_watch.watch(SimpleNamespace(),Path(runtime),Path(runtime))
                sampler.assert_not_called()
                agents.return_value.show_tasks.assert_called_once()
                self.assertEqual(len(agents.return_value.show_tasks.call_args.args),3)
                bridge.assert_called_once_with(Path(runtime),clients)
                bridge.return_value.start.assert_called_once_with()
                bridge.return_value.stop.assert_called_once_with()
                producer.stop.assert_called_once_with()


class AgentRepaintTest(unittest.TestCase):
    def test_agent_view_repaints_on_shown_change_not_every_loop(self):
        from busybar_agents.events import Task
        from busybar_agents.tokens import TokenUsage
        producer=Mock(snapshot={}); producer.config={'serviceId':'service'}
        notifier=Mock(snapshot={}); notifier.config={'serviceId':'notifier'}
        clients={'agent':producer,'notifier':notifier}
        monitor=Mock(); monitor.pop_start_pressed.return_value=False
        base=1_800_000_000.0 - (1_800_000_000 % 60) + 50
        clock=[base]
        task=Task('s','t','claude','p','working',base-10,base-1,None,TokenUsage(10,20))
        registry=Mock(); registry.visible_tasks.side_effect=lambda now:[task]
        registry.known_turns.return_value=set(); registry.active_turns.return_value=set(); registry.active_count.return_value=1
        calls=[]
        def sleep(_):
            calls.append(clock[0])
            clock[0]+=0.25
            if abs(clock[0]-(base+1)) < 1e-9: task.token_rate=TokenUsage(30,40)
            if clock[0] >= base+16: raise KeyboardInterrupt
        with tempfile.TemporaryDirectory() as runtime:
            with patch.object(cloud_watch,'producers',return_value=clients), \
                 patch.object(cloud_watch,'PreviewBridge',create=True), \
                 patch.object(cloud_watch,'CodexTaskRegistry',return_value=registry), \
                 patch.object(cloud_watch,'RolloutWatcher'), \
                 patch.object(cloud_watch,'load_dot_thread_ids',return_value=set()), \
                 patch.object(cloud_watch,'AgentRenderer'), \
                 patch.object(cloud_watch,'AgentSignals') as agents, \
                 patch.object(cloud_watch,'notifier_sources',return_value=[]), \
                 patch.object(cloud_watch,'configured_checker',return_value=None), \
                 patch.object(cloud_watch,'ViewMode') as view, \
                 patch.object(cloud_watch,'read_spool',return_value=[]), \
                 patch.object(cloud_watch,'InputMonitor',return_value=monitor), \
                 patch.object(cloud_watch.time,'time',side_effect=lambda:clock[0]), \
                 patch.object(cloud_watch.time,'sleep',side_effect=sleep):
                view.return_value.allows.return_value=True
                agents.return_value.due=False; agents.return_value.pending=False
                with self.assertRaises(KeyboardInterrupt):
                    cloud_watch.watch(SimpleNamespace(),Path(runtime),Path(runtime))
        shown=[round(c.args[1]-base,2) for c in agents.return_value.show_tasks.call_args_list]
        self.assertEqual(shown,[0,1,6,10,15],'first draw, rate change, 5 s fallback, minute change, fallback')
