"""Retry ordinary transport/cache failures without losing producer liveness."""
import copy
import tempfile
import threading
import unittest
from unittest.mock import patch
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
            finally:
                released.set(); producer.stop()
                # Production stop has bounded joins. This fixture must await
                # every writer before deleting its private temporary outbox.
                for thread in producer._threads:
                    thread.join(timeout=3)
                    self.assertFalse(thread.is_alive(),'fixture worker did not stop')

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

    def test_flush_snapshot_retains_asset_body_when_collector_evicts_old_scene(self):
        entered=threading.Event(); resume=threading.Event(); errors=[]
        class HTTP:
            def __init__(self): self.calls=[]
            def request(self,method,path,body=None):
                self.calls.append((path,copy.deepcopy(body)))
                return {'hash':body['hash']} if path=='/api/assets' else {}
        with tempfile.TemporaryDirectory() as directory, patch('busybar_shared.cloud.LOCAL_ASSET_COUNT',1):
            http=HTTP(); producer=Producer(directory,{'role':'agent','serviceId':'a','instanceId':'m','epoch':'e'},http,clock=lambda:100)
            old=producer.asset('old.png',b'old immutable bytes')
            content=dict(kind='agent',level='info',title='A',detail='')
            producer.state.recognize('a',scene={'entryDurationMs':0,'commands':[{'offsetMs':0,'elements':[{'id':'old','type':'image','assetHash':old}]}]},**content)
            upload=producer._upload_assets
            def paused(*args,**kwargs):
                entered.set()
                if not resume.wait(2): raise AssertionError('collector did not complete without network lock')
                return upload(*args,**kwargs)
            producer._upload_assets=paused
            def flush():
                try: producer.flush()
                except Exception as error: errors.append(error)
            worker=threading.Thread(target=flush); worker.start()
            try:
                self.assertTrue(entered.wait(1))
                producer.state.recognize('a',scene={'entryDurationMs':0,'commands':[{'offsetMs':0,'elements':[]}]},**content)
                producer.asset('new.png',b'new bytes')
                self.assertNotIn(old,producer.state.data['assets'])
            finally: resume.set(); worker.join(2)
            self.assertFalse(worker.is_alive()); self.assertEqual(errors,[])
            uploads=[body for path,body in http.calls if path=='/api/assets']
            self.assertTrue(any(body['hash']==old and body['data']=='b2xkIGltbXV0YWJsZSBieXRlcw==' for body in uploads))
            producer._upload_assets=upload; producer.flush()
            self.assertTrue(any(path=='/api/publish' for path,_ in http.calls))

    def test_frozen_asset_retry_uses_snapshot_after_collector_replaces_record(self):
        entered=threading.Event(); resume=threading.Event(); errors=[]
        class HTTP:
            def __init__(self): self.calls=[]; self.first=True
            def request(self,method,path,body=None):
                self.calls.append((path,copy.deepcopy(body)))
                if path=='/api/publish' and self.first:
                    self.first=False; entered.set()
                    if not resume.wait(2): raise AssertionError('collector did not complete')
                    raise CloudError('asset_not_authorized',403)
                return {'hash':body['hash']} if path=='/api/assets' else {}
        with tempfile.TemporaryDirectory() as directory, patch('busybar_shared.cloud.LOCAL_ASSET_COUNT',1):
            http=HTTP(); producer=Producer(directory,{'role':'agent','serviceId':'a','instanceId':'m','epoch':'e'},http,clock=lambda:100)
            old=producer.asset('old.png',b'old retry bytes')
            content=dict(kind='agent',level='info',title='A',detail='')
            producer.state.recognize('a',scene={'entryDurationMs':0,'commands':[{'offsetMs':0,'elements':[{'id':'old','type':'image','assetHash':old}]}]},**content)
            def flush():
                try: producer.flush()
                except Exception as error: errors.append(error)
            worker=threading.Thread(target=flush); worker.start()
            try:
                self.assertTrue(entered.wait(1))
                producer.state.recognize('a',scene={'entryDurationMs':0,'commands':[{'offsetMs':0,'elements':[]}]},**content)
                producer.asset('new.png',b'new bytes')
                self.assertNotIn(old,producer.state.data['assets'])
            finally: resume.set(); worker.join(2)
            self.assertFalse(worker.is_alive()); self.assertEqual(errors,[])
            published=[body for path,body in http.calls if path=='/api/publish']
            self.assertEqual(len(published),2)
            self.assertEqual(published[0],published[1])
            self.assertEqual(sum(path=='/api/assets' and body['hash']==old for path,body in http.calls),2)
            producer.flush()
            self.assertEqual(producer.state.records['a']['acked'],producer.state.records['a']['version'])
