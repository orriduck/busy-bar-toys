import subprocess
import unittest
from unittest.mock import patch

from busybar_status.api import AuthError
from busybar_status.credentials import read_token


class CredentialTests(unittest.TestCase):
    def test_pending_keychain_permission_does_not_hang_forever(self):
        with patch("busybar_status.credentials.subprocess.run",
                   side_effect=subprocess.TimeoutExpired("security", 30)):
            with self.assertRaises(AuthError) as caught: read_token()
        self.assertIn("Keychain", str(caught.exception))


if __name__ == "__main__": unittest.main()
