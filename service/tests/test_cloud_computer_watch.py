from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from busybar_service import cloud_watch
from busybar_shared.cloud import atomic_json, CloudError

class ComputerWatchTest(unittest.TestCase):
    def manifest(self,root,phase='active'):
        value={'url':'https://control.test','deviceId':'a'*64,'computerId':'computer','instanceId':'mac','phase':phase,
               'services':{'codex':{'serviceId':'agent-id','template':'agent','epoch':'a'},'github':{'serviceId':'github-id','template':'notifier','epoch':'g'}},
               'routes':{'codex':'agent-id','github':'github-id'}}
        atomic_json(root/'cloud-computer.json',value);return value

    def test_watch_uses_distinct_outboxes_and_one_keychain_read_with_explicit_targets(self):
        credential='a'*64+'.c.computer.'+'s'*43
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);self.manifest(root)
            with patch.object(cloud_watch,'keychain',return_value=credential) as keychain:
                clients=cloud_watch.producers(root)
            keychain.assert_called_once_with('computer')
            self.assertEqual(set(clients),{'codex','github'})
            self.assertEqual(clients['codex'].http.service_id,'agent-id')
            self.assertEqual(clients['github'].http.service_id,'github-id')
            self.assertNotEqual(clients['codex'].state.path,clients['github'].state.path)
            self.assertEqual(clients['github'].config['computerId'],'computer')

    def test_pending_computer_manifest_cannot_silently_fall_back_to_old_mixed_role(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);self.manifest(root,'pending')
            atomic_json(root/'cloud-notifier.json',{'url':'https://old.test','role':'notifier','serviceId':'old','instanceId':'mac','epoch':'old'})
            with self.assertRaisesRegex(CloudError,'computer_enrollment_pending'):cloud_watch.configurations(root)
