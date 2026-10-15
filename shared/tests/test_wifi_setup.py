import importlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, call, patch

from busybar_shared.api import AuthError, APIError
from busybar_shared.credentials import InputTokenMissing


WIFI={'state':'connected','ip_config':{'address':'192.168.99.189','ip_type':'ipv4'}}
TOKEN={'short_id':'Abcd1234','token':'Abcd1234synthetic-secret'}


class WifiSetupTests(unittest.TestCase):
    def setUp(self):
        try:
            self.setup=importlib.import_module('busybar_shared.wifi_setup')
        except ModuleNotFoundError:
            self.fail('Reusable Wi-Fi setup must be available before CLI wiring')

    def test_reuses_keychain_token_and_saves_only_private_address(self):
        client=Mock()
        client.request.return_value=WIFI
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'runtime'
            with patch.object(self.setup,'read_input_token',return_value='existing-secret') as read, \
                 patch.object(self.setup,'store_input_token') as store:
                result=self.setup.configure_wifi(client,root)
            self.assertEqual(result,{'addr':'192.168.99.189'})
            self.assertEqual(json.loads((root/'input.json').read_text()),result)
            self.assertEqual(root.stat().st_mode & 0o777,0o700)
            self.assertEqual((root/'input.json').stat().st_mode & 0o777,0o600)
        client.request.assert_called_once_with('/wifi/status')
        read.assert_called_once_with()
        store.assert_not_called()

    def test_missing_token_is_created_stored_and_confirmed_without_secret_in_config(self):
        client=Mock()
        client.request.side_effect=[WIFI,TOKEN]
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with patch.object(self.setup,'read_input_token',
                              side_effect=[InputTokenMissing('missing'),TOKEN['token']]) as read, \
                 patch.object(self.setup,'store_input_token') as store:
                self.setup.configure_wifi(client,root)
            self.assertNotIn('secret',(root/'input.json').read_text())
            self.assertEqual(json.loads((root/'input.json').read_text()),{'addr':'192.168.99.189'})
        store.assert_called_once_with(TOKEN['token'])
        self.assertEqual(read.call_count,2)
        self.assertEqual(client.request.call_args_list,[call('/wifi/status'),
            call('/access/tokens','POST',{'name':'Codex status input'})])

    def test_locked_or_denied_keychain_never_creates_a_replacement(self):
        client=Mock()
        client.request.return_value=WIFI
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(self.setup,'read_input_token',side_effect=AuthError('synthetic-secret')), \
             patch.object(self.setup,'store_input_token') as store:
            with self.assertRaises(RuntimeError) as caught:
                self.setup.configure_wifi(client,Path(directory))
            self.assertNotIn('synthetic-secret',str(caught.exception))
            self.assertEqual(list(Path(directory).iterdir()),[])
        client.request.assert_called_once_with('/wifi/status')
        store.assert_not_called()

    def test_new_token_is_revoked_if_store_or_readback_fails(self):
        for failure in ('store','readback'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                client=Mock()
                client.request.side_effect=[WIFI,TOKEN,{}]
                readback='wrong-token' if failure=='readback' else TOKEN['token']
                with patch.object(self.setup,'read_input_token',
                                  side_effect=[InputTokenMissing('missing'),readback]), \
                     patch.object(self.setup,'store_input_token',
                                  side_effect=AuthError('synthetic-secret') if failure=='store' else None):
                    with self.assertRaises(RuntimeError) as caught:
                        self.setup.configure_wifi(client,Path(directory))
                self.assertNotIn('synthetic-secret',str(caught.exception))
                self.assertEqual(client.request.call_args_list[-1],
                                 call('/access/tokens/Abcd1234','DELETE'))
                self.assertNotIn(call('/access/tokens','DELETE'),client.request.call_args_list)
                self.assertEqual(list(Path(directory).iterdir()),[])

    def test_verified_new_token_is_preserved_when_config_write_fails(self):
        client=Mock()
        client.request.side_effect=[WIFI,TOKEN]
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(self.setup,'read_input_token',
                          side_effect=[InputTokenMissing('missing'),TOKEN['token']]), \
             patch.object(self.setup,'store_input_token'), \
             patch.object(Path,'replace',side_effect=OSError('synthetic-secret')):
            with self.assertRaises(RuntimeError) as caught:
                self.setup.configure_wifi(client,Path(directory))
            self.assertNotIn('synthetic-secret',str(caught.exception))
            self.assertEqual(list(Path(directory).iterdir()),[])
        self.assertEqual(client.request.call_args_list,[call('/wifi/status'),
            call('/access/tokens','POST',{'name':'Codex status input'})])

    def test_invalid_or_public_wifi_address_fails_before_keychain_or_token_creation(self):
        for status in ({'state':'disconnected'},
                       {'state':'connected','address':'192.168.99.189'},
                       {'state':'connected','ip_config':{'address':'8.8.8.8'}},
                       {'state':'connected','ip_config':{'address':'192.168.1.2/path'}}):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                client=Mock()
                client.request.return_value=status
                with patch.object(self.setup,'read_input_token') as read:
                    with self.assertRaises(RuntimeError):
                        self.setup.configure_wifi(client,Path(directory))
                read.assert_not_called()
                client.request.assert_called_once_with('/wifi/status')

    def test_invalid_short_id_never_becomes_a_delete_path(self):
        for short_id in ('','../other','Abcd12345','Abcd123/',['bad']):
            with self.subTest(short_id=short_id), tempfile.TemporaryDirectory() as directory:
                client=Mock()
                client.request.side_effect=[WIFI,dict(TOKEN,short_id=short_id)]
                with patch.object(self.setup,'read_input_token',side_effect=InputTokenMissing('missing')), \
                     patch.object(self.setup,'store_input_token') as store:
                    with self.assertRaises(RuntimeError):
                        self.setup.configure_wifi(client,Path(directory))
                store.assert_not_called()
                self.assertEqual(client.request.call_count,2)

    def test_reused_token_is_never_revoked_when_config_write_fails(self):
        client=Mock()
        client.request.return_value=WIFI
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(self.setup,'read_input_token',return_value='existing-secret'), \
             patch.object(Path,'replace',side_effect=OSError('synthetic-secret')):
            with self.assertRaises(RuntimeError):
                self.setup.configure_wifi(client,Path(directory))
        client.request.assert_called_once_with('/wifi/status')

    def test_rollback_failure_does_not_expose_api_response_or_token(self):
        client=Mock()
        client.request.side_effect=[WIFI,TOKEN,APIError('synthetic-secret')]
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(self.setup,'read_input_token',side_effect=InputTokenMissing('missing')), \
             patch.object(self.setup,'store_input_token',side_effect=AuthError('synthetic-secret')):
            with self.assertRaises(RuntimeError) as caught:
                self.setup.configure_wifi(client,Path(directory))
        self.assertNotIn('synthetic-secret',str(caught.exception))
        self.assertEqual(client.request.call_args_list[-1],call('/access/tokens/Abcd1234','DELETE'))
