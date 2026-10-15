"""Retry ordinary transport/cache failures without losing producer liveness."""
import copy
import tempfile
import threading
import unittest
from busybar_shared.cloud import CloudError, Producer


class RecoveryTest(unittest.TestCase):
    def test_evicted_asset_reuploads_and_retries_exact_body_without_stopping(self):
        released=threading.Event(); accepted=threading.Event()
        class HTTP:
            def __init__(self): self.calls=[]; self.missing=True
            def request(self,method,path,body=None):
                self.calls.append((path,copy.deepcopy(body)))
                if path=='/api/publish':
                    if self.missing: self.missing=False; raise CloudError('asset_not_authorized',403)
                    accepted.set()
                if path=='/api/assets': return {'hash':body['hash']}
                return {'protocol':1,'revision':1,'services':[{'id':'a'}],'items':[]}
            def events(self):
                released.wait(3)
                if False: yield None
        with tempfile.TemporaryDirectory() as directory:
            http=HTTP(); producer=Producer(directory,{'role':'agent','serviceId':'a','instanceId':'m','epoch':'e'},http,clock=lambda:100,notify=lambda *a:None)
            digest=producer.asset('image.png',b'asset bytes')
            producer._assets[digest]=100
            producer.state.recognize('a',kind='agent',level='info',title='A',detail='',scene={'entryDurationMs':0,'commands':[{'offsetMs':0,'elements':[{'id':'image','type':'image','assetHash':digest}]}]})
            producer.start()
            try:
                self.assertTrue(accepted.wait(2),'asset eviction must not terminate a valid publisher')
                bodies=[body for path,body in http.calls if path=='/api/publish']
                self.assertGreaterEqual(len(bodies),2)
                self.assertEqual(bodies[0],bodies[1])
                self.assertTrue(any(path=='/api/assets' for path,_ in http.calls))
                self.assertTrue(producer._threads[0].is_alive())
            finally: released.set(); producer.stop()

    def test_revoked_input_grant_drops_event_and_keeps_publishing(self):
        class HTTP:
            def __init__(self): self.published=False
            def request(self,method,path,body=None):
                if path=='/api/input': raise CloudError('input_forbidden',403)
                if path=='/api/publish': self.published=True
                return {}
        with tempfile.TemporaryDirectory() as directory:
            http=HTTP(); producer=Producer(directory,{'role':'agent','serviceId':'a','instanceId':'m','epoch':'e'},http,clock=lambda:100)
            producer.snapshot={'generation':1}; producer.input(); producer.flush()
            self.assertEqual(producer.state.data['inputs'],{})
            producer.state.recognize('a',kind='agent',level='info',title='A',detail='',scene={'entryDurationMs':0,'commands':[{'offsetMs':0,'elements':[]}]})
            producer.flush(); self.assertTrue(http.published)
