"""Maintenance must not queue behind feature I/O or resurrect stale work."""
import tempfile
import threading
import unittest
from busybar_shared.cloud import Producer, CloudError

class MaintenanceTest(unittest.TestCase):
    config={'role':'fixture','serviceId':'fixture','instanceId':'demo','epoch':'e'}
    def test_heartbeat_progresses_during_blocked_outbox_and_preserves_diagnostics(self):
        entered=threading.Event();release=threading.Event();beats=threading.Event()
        class HTTP:
            def request(self,method,path,body=None):
                if path=='/api/publish':entered.set();release.wait(3)
                if path=='/api/heartbeat':beats.set()
                return {}
        with tempfile.TemporaryDirectory() as root:
            p=Producer(root,self.config,HTTP(),clock=lambda:100)
            p.state.recognize('source',kind='condition',level='default',title='fixture',detail='',scene={'commands':[]})
            worker=threading.Thread(target=lambda:p.flush())
            worker.start();maintenance=None
            try:
                self.assertTrue(entered.wait(1))
                maintenance=threading.Thread(target=p._heartbeat_run);maintenance.start()
                self.assertTrue(beats.wait(.5),'heartbeat was blocked behind publish')
                self.assertTrue(worker.is_alive())
                self.assertEqual(p.request_diagnostics()['inFlight']['endpoint'],'/api/publish')
            finally:
                p._stop.set();release.set();worker.join(2)
                if maintenance:maintenance.join(2)
            self.assertIsNone(p.request_diagnostics()['inFlight'])

    def test_failed_business_retry_does_not_suppress_maintenance(self):
        now=[100];bodies=[]
        class HTTP:
            def request(self,method,path,body=None):
                if path=='/api/publish':raise CloudError('http_503',503)
                if path=='/api/heartbeat':bodies.append(body)
                return {}
        with tempfile.TemporaryDirectory() as root:
            p=Producer(root,self.config,HTTP(),clock=lambda:now[0])
            p.state.recognize('source',kind='condition',level='default',title='fixture',detail='',scene={'commands':[]})
            for tick in (100,105,110,115,120):
                now[0]=tick
                with self.assertRaises(CloudError):p.flush()
                p.maintain_presence()
            self.assertEqual(len(bodies),5)
            self.assertTrue(all(b['itemIds']==[] for b in bodies))

    def test_presence_never_renews_fresh_stale_unknown_or_tombstoned_items(self):
        now=[100];bodies=[]
        class HTTP:
            def request(self,method,path,body=None):bodies.append(body);return {}
        with tempfile.TemporaryDirectory() as root:
            p=Producer(root,self.config,HTTP(),clock=lambda:now[0])
            for name in ('fresh','stale','unknown','ended'):
                p.state.recognize(name,kind='condition',level='default',title=name,detail='',scene={'commands':[]})
                p.state.records[name]['acked']=1
            p.state.records['stale']['sourceFreshUntil']=99000
            p.state.records['unknown']['sourceUnknown']=True
            p.state.records['ended']['tombstone']='ended'
            p.state.records['fresh']['sourceFreshUntil']=106000
            fresh=p.state.records['fresh']['itemId'];p.maintain_presence()
            self.assertEqual(bodies[-1]['itemIds'],[])
            self.assertEqual(bodies[-1]['validUntil'],160000)
            now[0]=107;p.maintain_presence()
            self.assertEqual(bodies[-1]['itemIds'],[])

    def test_runtime_registers_separate_maintenance_worker(self):
        from unittest.mock import patch
        class HTTP:pass
        with tempfile.TemporaryDirectory() as root:
            p=Producer(root,self.config,HTTP())
            with patch('busybar_shared.cloud.threading.Thread') as thread:
                p.start()
            targets=[call.kwargs['target'] for call in thread.call_args_list]
            self.assertIn(p._run,targets);self.assertIn(p._heartbeat_run,targets)

    def test_presence_does_not_wait_for_business_state_or_run_snapshot_callbacks(self):
        from unittest.mock import Mock
        sent=threading.Event()
        class HTTP:
            def request(self,*args):sent.set();return {'protocol':1,'revision':1}
        with tempfile.TemporaryDirectory() as root:
            p=Producer(root,self.config,HTTP(),clock=lambda:100)
            p.accept=Mock(side_effect=AssertionError('business callback on maintenance lane'))
            with p.state.lock:
                worker=threading.Thread(target=p.maintain_presence);worker.start()
                self.assertTrue(sent.wait(.5))
                worker.join(.5)
                self.assertFalse(worker.is_alive())
            p.accept.assert_not_called()
