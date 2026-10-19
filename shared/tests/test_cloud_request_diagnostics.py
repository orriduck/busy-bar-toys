"""Request timing is bounded metadata and never controls acknowledgement."""
import base64
import json
import tempfile
import threading
import unittest
from busybar_shared.cloud import Producer,CloudError


class RequestDiagnosticsTest(unittest.TestCase):
    config={'role':'fixture','serviceId':'fixture','instanceId':'demo','epoch':'e'}

    def test_inflight_http_does_not_lock_diagnostics_or_state(self):
        entered=threading.Event();release=threading.Event();answer=[]
        class HTTP:
            def request(self,*args):entered.set();release.wait(2);return {}
        with tempfile.TemporaryDirectory()as root:
            p=Producer(root,self.config,HTTP(),clock=lambda:100)
            worker=threading.Thread(target=lambda:p._response('GET','/api/snapshot'));worker.start()
            reader=None
            try:
                self.assertTrue(entered.wait(1))
                def read():
                    with p.state.lock:answer.append(p.request_diagnostics())
                reader=threading.Thread(target=read);reader.start();reader.join(.2)
                self.assertFalse(reader.is_alive())
                self.assertEqual(answer[0]['inFlight']['endpoint'],'/api/snapshot')
                self.assertEqual(answer[0]['inFlight']['phase'],'http')
                self.assertGreaterEqual(answer[0]['inFlight']['elapsedMs'],0)
            finally:
                release.set();worker.join(2)
                if reader:reader.join(2)
            self.assertIsNone(p.request_diagnostics()['inFlight'])

    def test_bounded_metadata_excludes_bodies_paths_errors_and_hashes(self):
        secret='private-synthetic-marker'
        class HTTP:
            def __init__(self):self.fail=False;self.calls=[]
            def request(self,method,path,body):
                self.calls.append((method,path,body))
                if self.fail:raise CloudError(secret,403)
                return {}
        with tempfile.TemporaryDirectory()as root:
            http=HTTP();p=Producer(root,self.config,http,clock=lambda:100)
            body={'hash':secret,'data':base64.b64encode(b'public7').decode()}
            p._request('POST','/api/assets',body)
            self.assertEqual(p.request_diagnostics()['recent'][0]['assetBytes'],7)
            self.assertIs(http.calls[0][2],body)
            http.fail=True
            for _ in range(70):
                with self.assertRaises(CloudError):p._request('POST','/api/actions/'+secret+'/result',{'text':secret})
            metrics=p.request_diagnostics();self.assertEqual(len(metrics['recent']),64)
            self.assertNotIn(secret,json.dumps(metrics));self.assertIsNone(metrics['inFlight'])
            self.assertTrue(all(r['endpoint']=='/api/other' and not r['ok']for r in metrics['recent']))
            metrics['recent'][0]['endpoint']='changed'
            self.assertEqual(p.request_diagnostics()['recent'][0]['endpoint'],'/api/other')

    def test_snapshot_acceptance_is_timed_separately_from_network(self):
        class HTTP:
            def request(self,*args):return {'protocol':1,'secret':'synthetic-private-body'}
        with tempfile.TemporaryDirectory()as root:
            p=Producer(root,self.config,HTTP(),clock=lambda:100);seen=[]
            p.accept=lambda snapshot:seen.append(p.request_diagnostics()['inFlight']['phase'])
            p._response('GET','/api/snapshot')
            metrics=p.request_diagnostics()
            self.assertEqual(seen,['accept'])
            self.assertEqual([r['phase']for r in metrics['recent']],['http','accept'])
            self.assertNotIn('synthetic-private-body',json.dumps(metrics))
