import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from busybar_shared.running_apps import sample


class RunningAppsTest(unittest.TestCase):
    def test_native_failures_and_invalid_output_are_unknown_not_empty_success(self):
        for output in [b'[]',b'invalid',b'x'*65537]:
            with self.subTest(output_size=len(output)), patch('busybar_shared.running_apps.subprocess.run',return_value=SimpleNamespace(stdout=output)):
                self.assertIsNone(sample(['com.example.game']))
        with patch('busybar_shared.running_apps.subprocess.run',side_effect=subprocess.TimeoutExpired('helper',3)):
            self.assertIsNone(sample(['com.example.game']))

    def test_only_local_bundle_filters_are_sent_and_no_shell_is_used(self):
        with patch('busybar_shared.running_apps.subprocess.run',return_value=SimpleNamespace(stdout=b'{"apps":[]}')) as run:
            self.assertEqual(sample(['com.example.game','com.example.game']),{'apps':[]})
        self.assertEqual(run.call_args.args[0][1:],['com.example.game'])
        self.assertNotIn('shell',run.call_args.kwargs)
        self.assertEqual(run.call_args.kwargs['timeout'],3)
