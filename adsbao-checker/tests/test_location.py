"""Location files use synthetic values; tests never request macOS permission."""
from dataclasses import FrozenInstanceError
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import subprocess
import shutil
import sys

from adsbao_checker.location import (
    LocationFix, location_status, read_location, start_location_helper,
    stop_location_helper,
)


class LocationFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'location.json'
        self.now = 1000.0
        self.payload = dict(status='ok', latitude=40.0, longitude=-70.0,
                            accuracy=10.0, timestamp=self.now)

    def write(self, **changes):
        self.path.write_text(json.dumps(self.payload | changes))

    def test_returns_immutable_valid_fix_at_inclusive_boundaries(self):
        self.write(latitude=-90, longitude=180, accuracy=500, timestamp=700)
        fix = read_location(self.path, now=self.now)
        self.assertEqual(fix, LocationFix(-90.0, 180.0, 500.0, 700.0))
        with self.assertRaises(FrozenInstanceError):
            fix.latitude = 20

    def test_rejects_stale_future_and_invalid_numeric_fix_fields(self):
        for field, values in {
            'latitude': [True, None, '40', 90.01, -90.01, math.inf, math.nan],
            'longitude': [False, None, '70', 180.01, -180.01, math.inf],
            'accuracy': [True, None, '10', -1, 500.01, math.nan, 10**400],
            'timestamp': [False, None, '1000', 699.99, 1000.01, math.inf],
        }.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    self.write(**{field: value})
                    self.assertIsNone(read_location(self.path, now=self.now))

    def test_rejects_missing_malformed_non_object_and_oversize_files(self):
        self.assertIsNone(read_location(self.path, now=self.now))
        for value in ['', '{', '[]', 'null', '"text"', 'x' * 20_000]:
            with self.subTest(value=value[:20]):
                self.path.write_text(value)
                self.assertIsNone(read_location(self.path, now=self.now))
        self.path.unlink()
        self.path.mkdir()
        self.assertIsNone(read_location(self.path, now=self.now))

    def test_does_not_follow_symlink_location_files(self):
        target = self.path.with_name('other.json')
        target.write_text(json.dumps(self.payload))
        self.path.symlink_to(target)
        self.assertIsNone(read_location(self.path, now=self.now))

    def test_permission_or_error_status_never_yields_coordinates(self):
        for status in ['denied', 'not_determined', 'services_disabled', 'unavailable',
                       'restricted', 'acquiring', 'timeout', 'unknown']:
            with self.subTest(status=status):
                self.write(status=status)
                self.assertIsNone(read_location(self.path, now=self.now))

    def test_status_is_safe_metadata_even_for_untrusted_error_messages(self):
        self.write(message='coordinates 40,-70', arbitrary='secret')
        self.assertEqual(location_status(self.path, now=self.now),
                         {'status': 'ok', 'age_seconds': 0.0, 'accuracy_m': 10.0})
        self.write(status='denied', message='coordinates 40,-70')
        self.assertEqual(location_status(self.path, now=self.now), {'status': 'denied'})
        self.write(status='coordinates 40,-70')
        self.assertEqual(location_status(self.path, now=self.now), {'status': 'unavailable'})

    def test_status_distinguishes_missing_invalid_stale_and_poor_accuracy(self):
        self.assertEqual(location_status(self.path, now=self.now), {'status': 'missing'})
        for changes, status in [({'timestamp': 699}, 'stale'),
                                ({'accuracy': 501}, 'poor_accuracy'),
                                ({'latitude': True}, 'invalid')]:
            self.write(**changes)
            self.assertEqual(location_status(self.path, now=self.now)['status'], status)


class LocationHelperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.runtime = self.repo / 'runtime'
        self.executable = self.repo / '.venv/BusyBarLocation.app/Contents/MacOS/BusyBarLocation'
        self.executable.parent.mkdir(parents=True)
        self.executable.write_text('helper')
        self.executable.chmod(0o700)
        self.process = Mock()
        self.process.poll.return_value = None
        self.addCleanup(stop_location_helper, None)

    @patch('adsbao_checker.location.sys.platform', 'darwin')
    @patch('adsbao_checker.location.subprocess.Popen')
    def test_starts_one_managed_helper_silently_and_stops_it(self, popen):
        popen.return_value = self.process
        handle = start_location_helper(self.repo, self.runtime)
        self.assertIsNotNone(handle)
        self.assertIs(start_location_helper(self.repo, self.runtime), handle)
        self.assertEqual(popen.call_count, 1)
        args, kwargs = popen.call_args
        self.assertEqual(args[0][0], str(self.executable))
        self.assertNotIn('--request-authorization', args[0])
        self.assertIn('--runtime', args[0])
        self.assertEqual(self.runtime.stat().st_mode & 0o777, 0o700)
        self.assertEqual(kwargs['stdout'], -3)
        self.assertEqual(kwargs['stderr'], -3)
        stop_location_helper(handle)
        self.process.terminate.assert_called_once()
        self.process.wait.assert_called_once_with(timeout=5)
        stop_location_helper(handle)
        self.assertEqual(self.process.terminate.call_count, 1)

    @patch('adsbao_checker.location.sys.platform', 'darwin')
    @patch('adsbao_checker.location.subprocess.Popen')
    def test_explicit_setup_requests_authorization(self, popen):
        popen.return_value = self.process
        handle = start_location_helper(self.repo, self.runtime, request_authorization=True)
        self.assertIn('--request-authorization', popen.call_args.args[0])
        stop_location_helper(handle)

    @patch('adsbao_checker.location.sys.platform', 'darwin')
    @patch('adsbao_checker.location.subprocess.Popen')
    def test_missing_bundle_fails_closed_without_building_or_prompt(self, popen):
        self.executable.unlink()
        self.assertIsNone(start_location_helper(self.repo, self.runtime))
        popen.assert_not_called()

    @patch('adsbao_checker.location.sys.platform', 'darwin')
    @patch('adsbao_checker.location.subprocess.Popen')
    def test_stop_handles_native_exit_race(self, popen):
        popen.return_value = self.process
        handle = start_location_helper(self.repo, self.runtime)
        self.process.terminate.side_effect = ProcessLookupError()
        stop_location_helper(handle)
        self.process.wait.assert_called_once_with(timeout=5)

    @patch('adsbao_checker.location.sys.platform', 'darwin')
    @patch('adsbao_checker.location.subprocess.Popen')
    def test_stop_kills_helper_that_does_not_terminate(self, popen):
        popen.return_value = self.process
        handle = start_location_helper(self.repo, self.runtime)
        self.process.wait.side_effect = [subprocess.TimeoutExpired('helper', 5), 0]
        stop_location_helper(handle)
        self.process.kill.assert_called_once()
        self.assertEqual(self.process.wait.call_count, 2)

    @patch('adsbao_checker.location.sys.platform', 'linux')
    @patch('adsbao_checker.location.subprocess.Popen')
    def test_non_macos_does_not_launch(self, popen):
        self.assertIsNone(start_location_helper(self.repo, self.runtime, request_authorization=True))
        popen.assert_not_called()


@unittest.skipUnless(sys.platform == 'darwin' and shutil.which('xcrun'), 'native policy requires macOS Swift')
class NativeAuthorizationPolicyTests(unittest.TestCase):
    def test_unavailable_watch_releases_lock_before_later_setup(self):
        # Compile only the real pure policy, without AppKit, a location manager,
        # application startup, or access to the actual location runtime file.
        source = (Path(__file__).resolve().parents[1] / 'macos/BusyBarLocation.swift').read_text()
        policy = source.split('// BEGIN AUTHORIZATION_LOCK_POLICY\n')[1].split('// END AUTHORIZATION_LOCK_POLICY')[0]
        checks = r'''
precondition(shouldReleaseAuthorizationLock(status: "not_determined", mayAuthorize: false))
precondition(!shouldReleaseAuthorizationLock(status: "not_determined", mayAuthorize: true))
for mayAuthorize in [false, true] {
    for status in ["denied", "restricted", "services_disabled"] {
        precondition(shouldReleaseAuthorizationLock(status: status, mayAuthorize: mayAuthorize))
    }
    for status in ["ok", "acquiring", "timeout", "unavailable"] {
        precondition(!shouldReleaseAuthorizationLock(status: status, mayAuthorize: mayAuthorize))
    }
}
'''
        with tempfile.TemporaryDirectory() as directory:
            main = Path(directory) / 'main.swift'
            executable = Path(directory) / 'policy-tests'
            main.write_text(policy + checks)
            subprocess.run(['xcrun', 'swiftc', str(main), '-o', str(executable)], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            subprocess.run([str(executable)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_stationary_fix_refreshes_before_expiry_without_retry_storm(self):
        source = (Path(__file__).resolve().parents[1] / 'macos/BusyBarLocation.swift').read_text()
        policy = source.split('// BEGIN AUTHORIZATION_LOCK_POLICY\n')[1].split('// END AUTHORIZATION_LOCK_POLICY')[0]
        checks = r'''
// A stationary fix is refreshed long before the five-minute validity boundary.
precondition(!shouldRefreshLocationFix(fixAge: 119, secondsSinceAttempt: 120))
precondition(shouldRefreshLocationFix(fixAge: 120, secondsSinceAttempt: 120))
precondition(shouldRefreshLocationFix(fixAge: 299, secondsSinceAttempt: 60))
// Cached callbacks must not cause a restart on every five-second timer tick.
precondition(!shouldRefreshLocationFix(fixAge: 299, secondsSinceAttempt: 5))
precondition(!shouldRefreshLocationFix(fixAge: 299, secondsSinceAttempt: 59.99))
// Lack of any valid fix also retries at a bounded interval.
precondition(!shouldRefreshLocationFix(fixAge: nil, secondsSinceAttempt: 30))
precondition(shouldRefreshLocationFix(fixAge: nil, secondsSinceAttempt: 60))
precondition(!shouldRefreshLocationFix(fixAge: 1, secondsSinceAttempt: 300))
'''
        with tempfile.TemporaryDirectory() as directory:
            main = Path(directory) / 'main.swift'
            executable = Path(directory) / 'policy-tests'
            main.write_text(policy + checks)
            subprocess.run(['xcrun', 'swiftc', str(main), '-o', str(executable)], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            subprocess.run([str(executable)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


if __name__ == '__main__':
    unittest.main()
