import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock

from busybar_status.cli import watch


class IdleWatchTests(unittest.TestCase):
    def test_observer_keeps_clock_and_speed_visible_with_no_active_task(self):
        with tempfile.TemporaryDirectory() as directory:
            api=Mock()
            with patch('busybar_status.cli.RUNTIME',Path(directory)), \
                 patch('busybar_status.cli.read_token',return_value='test-only'), \
                 patch('busybar_status.cli.BusyAPI',return_value=api), \
                 patch('busybar_status.cli.RolloutWatcher'), \
                 patch('busybar_status.cli.NetworkSampler') as sampler, \
                 patch('busybar_status.cli.load_dot_thread_ids',return_value=set()), \
                 patch('busybar_status.cli.read_spool',return_value=[]), \
                 patch('busybar_status.cli.time.sleep',side_effect=KeyboardInterrupt), \
                 patch('busybar_status.cli.signal.signal'):
                sampler.return_value.sample.return_value=None
                with self.assertRaises(KeyboardInterrupt):
                    watch(SimpleNamespace(dot_thread=[]))
            self.assertEqual(api.draw.call_count,1)
            payload=api.draw.call_args.args[0]
            self.assertEqual(payload['application_name'],'ai-status')
            self.assertTrue(all(e['type']!='animation' for e in payload['elements']))
            api.clear.assert_called_once()


if __name__=='__main__': unittest.main()
