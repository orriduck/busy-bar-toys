"""Existing downlink lanes preserve queue ownership under overlapping failures."""
import copy
import json
import tempfile
import threading
import unittest
from unittest.mock import patch
from busybar_shared.cloud import CloudError, Producer, State


class Steps:
    def __init__(self, count, clock=None):self.count=count;self.clock=clock;self.delays=[]
    def is_set(self):return self.count<=0
    def wait(self, seconds):
        self.delays.append(seconds);self.count-=1
        if self.clock is not None:self.clock[0]+=seconds
        return self.is_set()


class SnapshotFallbackContractTest(unittest.TestCase):
    config={'role':'fixture','serviceId':'a','instanceId':'m','epoch':'e'}
    scene={'entryDurationMs':0,'commands':[{'offsetMs':0,'elements':[]}]}

    def recognize(self,p,key,level='info'):
        return p.state.recognize(key,kind='condition',level=level,title=key,detail='',scene=self.scene)

    def outbox(self,p):
        self.recognize(p,'pending-end');p.state.clear('pending-end')
        with p.state.lock:
            p.state.data['actions']['result']={'status':'succeeded','sent':False,'outbox':['succeeded']}
            p.state.data['inputs']['input']={'eventId':'input','instanceId':'m','generation':1,'button':'start_pause'}
            p.state.save()
        return {k:copy.deepcopy(p.state.data[k])for k in ('ends','actions','inputs')}

    def assert_outbox(self,p,expected):
        loaded=State(p.state.path).data
        for key,value in expected.items():self.assertEqual(loaded[key],value)

    def snapshot(self,p,revision=10,now=100000,receipt=True):
        keep=p.state.records['keep'];gone=p.state.records['gone']
        key=lambda rec:json.dumps(['a','m',rec['itemId']],separators=(',',':'))
        return {'protocol':1,'revision':revision,'serverNow':now,'services':[{'id':'a'}],
                'health':{'status':'healthy'},'generation':1,
                'items':[{'serviceId':'a','instanceId':'m','itemId':keep['itemId'],'itemKey':key(keep),'version':keep['version'],'state':'waiting'}],
                'tombstones':[{'itemKey':key(gone),'reason':'manual'}]if receipt else []}

    def test_persistent_sse_429_does_not_disable_existing_poll_or_ack_outbox(self):
        tick=[100.0];attempts=[];polls=[];responses=[]
        class HTTP:
            def events(self):attempts.append(True);raise CloudError('http_429',429)
            def request(self,method,path,body=None):
                self.assert_path(path);polls.append(tick[0])
                value=copy.deepcopy(responses[0]);value['serverNow']=round(tick[0]*1000);return value
            @staticmethod
            def assert_path(path):
                if path!='/api/snapshot':raise AssertionError('poll performed business I/O')
        with tempfile.TemporaryDirectory()as root,patch('busybar_shared.cloud.time.monotonic',side_effect=lambda:tick[0]):
            p=Producer(root,self.config,HTTP(),clock=lambda:tick[0],notify=lambda *a:None)
            keep=self.recognize(p,'keep');self.recognize(p,'gone');pending=self.outbox(p)
            before=p.state.path.read_bytes();p._stop=Steps(4);p._events()
            self.assertEqual(len(attempts),4);self.assertEqual(p._stop.delays,[1,2,4,8])
            self.assertEqual(p.state.path.read_bytes(),before)
            responses.append(self.snapshot(p,now=round(tick[0]*1000)))
            receipts=[];p.on_tombstone=lambda *a:receipts.append(a)
            p._stop=Steps(12,tick);p._poll_snapshots()
            self.assertEqual(len(polls),2)
            self.assertEqual(p.snapshot['revision'],10)
            self.assertEqual(receipts,[(p.state.records['gone']['itemId'],'manual')])
            self.assertEqual(p.state.records['keep']['itemId'],keep['itemId'])
            self.assertEqual(p.state.records['keep']['acked'],0)
            self.assertFalse(p.state.records['keep'].get('admitted',False))
            self.assertEqual(p.state.records['keep'].get('proofUntil',0),0)
            self.assert_outbox(p,pending)

    def test_poll_progresses_through_sse_429_while_business_upload_is_blocked(self):
        upload=threading.Event();release=threading.Event();sse=threading.Event();accepted=threading.Event();responses=[]
        class HTTP:
            def events(self):sse.set();raise CloudError('http_429',429)
            def request(self,method,path,body=None):
                if path=='/api/publish':upload.set();release.wait(3);raise CloudError('unavailable')
                if path=='/api/snapshot':return copy.deepcopy(responses[0])
                raise AssertionError('unexpected business operation')
        with tempfile.TemporaryDirectory()as root:
            p=Producer(root,self.config,HTTP(),clock=lambda:100,notify=lambda *a:None)
            keep=self.recognize(p,'keep');self.recognize(p,'gone');responses.append(self.snapshot(p))
            original=p.accept
            def accept(value):original(value);accepted.set()
            p.accept=accept;p._heart=100
            workers=[threading.Thread(target=target)for target in (p._run,p._events,p._poll_snapshots)]
            workers[0].start()
            try:
                self.assertTrue(upload.wait(1));pending=self.outbox(p)
                workers[1].start();self.assertTrue(sse.wait(1));workers[2].start()
                self.assertTrue(accepted.wait(1),'poll waited behind blocked upload/SSE reconnect')
                self.assertTrue(workers[0].is_alive());self.assertEqual(p.snapshot['revision'],10)
                self.assertEqual(p.state.records['keep']['acked'],0)
                self.assertEqual(p.state.records['keep']['itemId'],keep['itemId']);self.assert_outbox(p,pending)
            finally:
                p._stop.set();release.set()
                for worker in workers:
                    if worker.ident:worker.join(2);self.assertFalse(worker.is_alive())

    def test_failed_poll_cannot_renew_proof_ack_reset_identity_or_drop_pending_work(self):
        tick=[100.0];notices=[];requests=[]
        class HTTP:
            def request(self,*args):requests.append(True);raise CloudError('unavailable')
        with tempfile.TemporaryDirectory()as root,patch('busybar_shared.cloud.time.monotonic',side_effect=lambda:tick[0]):
            p=Producer(root,self.config,HTTP(),clock=lambda:tick[0],notify=lambda *a:notices.append(a))
            keep=self.recognize(p,'keep','urgent');self.recognize(p,'gone');pending=self.outbox(p)
            value=self.snapshot(p,revision=7,receipt=False);item=value['items'][0]
            value['displaying']={'itemKey':item['itemKey'],'generation':1,'confirmedValidUntil':102000}
            item['coverageProof']={'itemKey':item['itemKey'],'version':1,'revision':7,
                                   'controller':{'itemKey':item['itemKey'],'generation':1},'validUntil':102000}
            p.accept(value);tick[0]=108
            before=p.state.path.read_bytes();deadline=p.state.records['keep']['deadline']
            p._stop=Steps(3,tick);p._poll_snapshots()
            self.assertEqual(len(requests),3);self.assertEqual(p._stop.delays,[1,2,4])
            self.assertEqual(p.state.path.read_bytes(),before);self.assertTrue(p._snapshot_due())
            self.assertEqual(p.state.records['keep']['deadline'],deadline)
            self.assertEqual(p.state.records['keep']['proofUntil'],102000)
            self.assertEqual(p.state.records['keep']['acked'],0)
            self.assertEqual(p.state.records['keep']['itemId'],keep['itemId']);self.assert_outbox(p,pending)
            p.guard.check();p.guard.check()
            self.assertEqual(len(notices),1,'failed channels suppressed or duplicated finite fallback')

    def test_recovered_sse_wins_over_delayed_older_or_rejected_foreign_poll(self):
        for late_kind in ('older','foreign'):
            with self.subTest(late=late_kind),tempfile.TemporaryDirectory()as root:
                failed=threading.Event();blocked=threading.Event();release=threading.Event()
                recovered=threading.Event();processed=threading.Event();hold_sse=threading.Event();responses=[];calls=[]
                class HTTP:
                    def request(self,method,path,body=None):
                        calls.append(path)
                        if len(calls)==1:failed.set();raise CloudError('unavailable')
                        blocked.set();release.wait(3);return copy.deepcopy(responses[1])
                    def events(self):
                        yield copy.deepcopy(responses[0]);yield copy.deepcopy(responses[0]);hold_sse.wait(3)
                p=Producer(root,self.config,HTTP(),clock=lambda:100,notify=lambda *a:None)
                keep=self.recognize(p,'keep');self.recognize(p,'gone');pending=self.outbox(p)
                good=self.snapshot(p,revision=10)
                late=self.snapshot(p,revision=9,now=101000,receipt=False)
                if late_kind=='foreign':late['revision']=100;late['items'][0]['serviceId']='foreign'
                responses.extend([good,late]);receipts=[];p.on_tombstone=lambda *a:receipts.append(a)
                original=p.accept
                def accept(value):
                    try:original(value)
                    finally:
                        (recovered if value['revision']==10 else processed).set()
                p.accept=accept
                poll=threading.Thread(target=p._poll_snapshots);stream=threading.Thread(target=p._events)
                poll.start()
                try:
                    self.assertTrue(failed.wait(1));self.assertTrue(blocked.wait(2))
                    stream.start();self.assertTrue(recovered.wait(1),'SSE waited behind the failed/blocked poll')
                    release.set();self.assertTrue(processed.wait(1))
                    self.assertEqual(p.snapshot['revision'],10)
                    self.assertEqual(p.state.data['watchRevision'],10)
                    self.assertEqual(receipts,[(p.state.records['gone']['itemId'],'manual')])
                    self.assertEqual(p.state.records['gone']['tombstone'],'manual')
                    self.assertEqual(p.state.records['keep']['itemId'],keep['itemId'])
                    self.assertEqual(p.state.records['keep']['acked'],0);self.assert_outbox(p,pending)
                finally:
                    p._stop.set();release.set();hold_sse.set();poll.join(2)
                    if stream.ident:stream.join(2)
                    self.assertFalse(poll.is_alive());self.assertFalse(stream.is_alive())
