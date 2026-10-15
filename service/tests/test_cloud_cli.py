from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch
from busybar_service import cli

class CloudCLITest(unittest.TestCase):
    def test_cli_dispatches_cloud_without_constructing_device(self):
        with patch('busybar_service.cli.watch',return_value=0) as watch:
            self.assertEqual(cli.main(['watch','--mode','cloud']),0)
            self.assertEqual(watch.call_args.args[0].mode,'cloud')
        with patch('busybar_service.cli.read_token',side_effect=AssertionError('device token')):
            with patch('busybar_service.cloud_watch.watch',return_value=0) as cloud_watch:
                self.assertEqual(cli.watch(SimpleNamespace(mode='cloud')),0)
                cloud_watch.assert_called_once()

    def test_cloud_install_uses_only_cloud_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); plist=root/'agent.plist'
            with patch('busybar_service.cli.RUNTIME',root), patch('busybar_service.cli.PLIST',plist), \
                 patch('busybar_service.cli.read_token',side_effect=AssertionError('device token')), \
                 patch('busybar_service.cli.Path.home',return_value=root), \
                 patch('busybar_service.cli._service'), \
                 patch('busybar_service.cli.subprocess.run',return_value=SimpleNamespace(returncode=0)), \
                 patch('busybar_service.cloud_watch.configurations',return_value=[{'role':'agent'}]):
                cli.install(mode='cloud')
            import plistlib
            self.assertEqual(plistlib.loads(plist.read_bytes())['ProgramArguments'][-2:],['--mode','cloud'])

    def test_cloud_status_does_not_use_device_credentials(self):
        with patch('busybar_service.cli.read_token',side_effect=AssertionError('device token')), \
             patch('busybar_service.cloud_watch.status',return_value=0) as status:
            self.assertEqual(cli.main(['status','--mode','cloud']),0)
            status.assert_called_once()
