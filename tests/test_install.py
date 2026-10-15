from pathlib import Path
import subprocess
import plistlib
import tempfile
import unittest
from unittest.mock import patch

from busybar_status.cli import install


class InstallTests(unittest.TestCase):
    def test_reduced_motion_option_reaches_background_observer(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with patch('busybar_status.cli.RUNTIME',root/'runtime'), \
                 patch('busybar_status.cli.PLIST',root/'agent.plist'), \
                 patch('busybar_status.cli.Path.home',return_value=root), \
                 patch('busybar_status.cli.read_token',return_value='test-only'), \
                 patch('busybar_status.cli._service'), \
                 patch('busybar_status.cli.subprocess.run',return_value=subprocess.CompletedProcess([],0)):
                install(reduced_motion=True)
                config=plistlib.loads((root/'agent.plist').read_bytes())
                self.assertEqual(config['ProgramArguments'][-2:],['watch','--reduced-motion'])
                install()
                config=plistlib.loads((root/'agent.plist').read_bytes())
                self.assertEqual(config['ProgramArguments'][-1],'watch')

    def test_reinstall_waits_for_previous_launchd_registration_to_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            attempts=[subprocess.CompletedProcess([],5)]*8+[subprocess.CompletedProcess([],0)]
            with patch('busybar_status.cli.RUNTIME',root/'runtime'), \
                 patch('busybar_status.cli.PLIST',root/'agent.plist'), \
                 patch('busybar_status.cli.Path.home',return_value=root), \
                 patch('busybar_status.cli.read_token',return_value='test-only'), \
                 patch('busybar_status.cli._service'), \
                 patch('busybar_status.cli.time.sleep'), \
                 patch('busybar_status.cli.subprocess.run',side_effect=attempts) as launcher:
                install()
                self.assertEqual(launcher.call_count,9)


if __name__=='__main__':unittest.main()
