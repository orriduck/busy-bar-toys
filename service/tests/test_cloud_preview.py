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
