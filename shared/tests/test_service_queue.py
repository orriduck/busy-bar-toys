"""Queue ownership is usable without a connection, transport or producer."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from busybar_shared.cloud import State, CloudError
from busybar_shared.service_queue import ServiceQueue

class Guard:
    def snapshot(self,snapshot):pass

class ServiceQueueContractTest(unittest.TestCase):
    config={'serviceId':'a','instanceId':'m','epoch':'e'}
    def setup_queue(self,root):
        state=State(Path(root)/'state.json',clock=lambda:100)
        state.recognize('source',kind='condition',level='info',title='fixture',detail='',scene={'commands':[]})
        return ServiceQueue(state,self.config,Guard(),clock=lambda:100,error_type=CloudError)

    def test_connection_snapshot_is_not_an_ack_and_explicit_ack_survives_restart(self):
        with tempfile.TemporaryDirectory() as root:
            queue=self.setup_queue(root);rec=copy.deepcopy(queue.state.records['source'])
            queue.accept({'protocol':1,'revision':1,'serverNow':100000,'items':[],'services':[]})
            self.assertEqual(queue.state.records['source']['acked'],0)
            queue.acknowledge(rec['itemId'],rec['version'])
            loaded=State(queue.state.path).records['source']
            self.assertEqual(loaded['acked'],1);self.assertEqual(loaded['itemId'],rec['itemId'])

    def test_snapshot_views_are_detached_and_stale_revisions_do_not_replace_them(self):
        with tempfile.TemporaryDirectory() as root:
            queue=self.setup_queue(root)
            queue.accept({'protocol':1,'revision':2,'items':[],'services':[]})
            view=queue.read_snapshot();view['items'].append({'itemId':'foreign'})
            queue.accept({'protocol':1,'revision':1,'items':[{'itemId':'old'}],'services':[]})
            self.assertEqual(queue.read_snapshot(),{'protocol':1,'revision':2,'items':[],'services':[]})

    def test_duplicate_tombstones_notify_once_and_persist_without_transport(self):
        with tempfile.TemporaryDirectory() as root:
            queue=self.setup_queue(root);rec=copy.deepcopy(queue.state.records['source']);calls=[]
            queue.on_tombstone=lambda *args:calls.append(args)
            key=json.dumps(['a','m',rec['itemId']],separators=(',',':'))
            snapshot={'protocol':1,'revision':1,'items':[],'services':[],
                      'tombstones':[{'itemKey':key,'reason':'manual'}]}
            queue.accept(snapshot);queue.accept(snapshot)
            self.assertEqual(calls,[(rec['itemId'],'manual')])
            self.assertEqual(State(queue.state.path).records['source']['tombstone'],'manual')
            self.assertEqual(queue.state.records['source']['itemId'],rec['itemId'])

    def test_recovery_does_not_advance_tombstoned_or_cleared_occurrences(self):
        for ended in ('tombstone','cleared'):
            with self.subTest(ended=ended),tempfile.TemporaryDirectory() as root:
                queue=self.setup_queue(root);rec=copy.deepcopy(queue.state.records['source'])
                queue.accept({'protocol':1,'revision':1,'serverNow':100000,'items':[],'services':[]})
                queue.state.records['source'][ended]='manual' if ended=='tombstone' else True
                self.assertIsNone(queue.recover_expired_publish(rec))
                self.assertEqual(queue.state.records['source']['version'],1)

    def test_queue_reconstruction_preserves_durable_state_without_channel_state(self):
        with tempfile.TemporaryDirectory() as root:
            queue=self.setup_queue(root);before=queue.state.path.read_bytes()
            restarted=ServiceQueue(State(queue.state.path),self.config,Guard(),clock=lambda:100,error_type=CloudError)
            self.assertEqual(restarted.state.path.read_bytes(),before)
            self.assertEqual(restarted.state.records,queue.state.records)
            self.assertEqual(restarted.read_snapshot(),{})
            self.assertTrue(restarted.snapshot_due())

    def test_old_ack_cannot_remove_newer_pending_update(self):
        with tempfile.TemporaryDirectory() as root:
            queue=self.setup_queue(root);live=queue.state.records['source']
            live['version']=2;live['update']=[{'id':'new'}]
            queue.acknowledge(live['itemId'],1)
            self.assertEqual(live['acked'],1);self.assertEqual(live['update'],[{'id':'new'}])
            queue.acknowledge(live['itemId'],2)
            self.assertEqual(live['acked'],2);self.assertNotIn('update',live)
