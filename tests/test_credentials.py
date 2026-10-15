import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from busybar_status.api import AuthError
from busybar_status.credentials import read_token
from busybar_status import credentials


class CredentialTests(unittest.TestCase):
    def test_pending_keychain_permission_does_not_hang_forever(self):
        with patch("busybar_status.credentials.subprocess.run",
                   side_effect=subprocess.TimeoutExpired("security", 30)):
            with self.assertRaises(AuthError) as caught: read_token()
        self.assertIn("Keychain", str(caught.exception))


class InputCredentialTests(unittest.TestCase):
    def method(self,name):
        result=getattr(credentials,name,None)
        self.assertIsNotNone(result,f'{name} must support the dedicated local Keychain item')
        return result

    def test_get_uses_captured_helper_output_and_a_five_second_timeout(self):
        read=self.method('read_input_token')
        with patch.object(credentials,'INPUT_HELPER',Path('/test/busy-input-keychain'),create=True), \
             patch.object(credentials.subprocess,'run',return_value=subprocess.CompletedProcess(
                 [],0,stdout='synthetic-secret\n',stderr='')) as run:
            self.assertEqual(read(),'synthetic-secret')
        run.assert_called_once_with(['/test/busy-input-keychain','get'],
                                    capture_output=True,text=True,timeout=5)

    def test_set_passes_secret_only_on_stdin(self):
        store=self.method('store_input_token')
        with patch.object(credentials,'INPUT_HELPER',Path('/test/busy-input-keychain'),create=True), \
             patch.object(credentials.subprocess,'run',return_value=subprocess.CompletedProcess(
                 [],0,stdout='',stderr='')) as run:
            store('synthetic-secret')
        run.assert_called_once_with(['/test/busy-input-keychain','set'],input='synthetic-secret',
                                    capture_output=True,text=True,timeout=5)

    def test_only_missing_item_exit_code_has_the_missing_token_type(self):
        read=self.method('read_input_token')
        missing=self.method('InputTokenMissing')
        self.assertTrue(issubclass(missing,AuthError))
        for code in (1,2):
            with self.subTest(code=code), patch.object(credentials.subprocess,'run',
                    return_value=subprocess.CompletedProcess([],code,stdout='synthetic-secret',
                                                              stderr='synthetic-secret')):
                with self.assertRaises(AuthError) as caught: read()
                self.assertEqual(isinstance(caught.exception,missing),code==2)
                self.assertNotIn('synthetic-secret',str(caught.exception))

    def test_helper_errors_and_invalid_tokens_are_sanitized_without_retry(self):
        read=self.method('read_input_token')
        store=self.method('store_input_token')
        for error in (OSError('synthetic-secret'),subprocess.TimeoutExpired('helper',5)):
            for operation in (read,lambda:store('synthetic-secret')):
                with self.subTest(error=type(error).__name__), \
                     patch.object(credentials.subprocess,'run',side_effect=error) as run:
                    with self.assertRaises(AuthError) as caught: operation()
                    self.assertNotIn('synthetic-secret',str(caught.exception))
                    self.assertEqual(run.call_count,1)
        for token in ('','two words','line\nbreak'):
            with self.subTest(token=token), patch.object(credentials.subprocess,'run') as run:
                with self.assertRaises(AuthError): store(token)
                run.assert_not_called()


if __name__ == "__main__": unittest.main()
