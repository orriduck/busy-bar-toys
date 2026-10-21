"""Contracts: lifecycle owns retries, not business persistence or delivery proof."""
import copy
import tempfile
import threading
import unittest
from busybar_shared.connection_lifecycle import PeriodicChannel, SnapshotStreamChannel
from busybar_shared.cloud import Producer, CloudError, State


class StopAfter:
    def __init__(self, waits):self.remaining=waits;self.delays=[]
    def is_set(self):return self.remaining<=0
    def wait(self,delay):self.delays.append(delay);self.remaining-=1;return self.is_set()


class LifecycleContractTest(unittest.TestCase):
    def test_stop_closes_the_owned_iterator_without_waiting_for_gc(self):
        closed=[];stop=StopAfter(1)
        class Stream:
            def __iter__(self):return self
            def __next__(self):return {'revision':1}
            def close(self):closed.append(True)
        def deliver(_):stop.remaining=0
        SnapshotStreamChannel(stop=stop,connect=Stream,deliver=deliver,
            errors=(CloudError,),terminal=lambda _:False,on_error=lambda _:None).run()
        self.assertEqual(closed,[True])

    def test_failure_budget_is_independent_and_success_resets_only_its_lane(self):
        def fail():raise CloudError('unavailable')
        first=StopAfter(4);second=StopAfter(2)
        a=PeriodicChannel(stop=first,operation=fail,errors=(CloudError,),terminal=lambda _:False,on_error=lambda _:None)
        b=PeriodicChannel(stop=second,operation=lambda:None,errors=(CloudError,),terminal=lambda _:False,on_error=lambda _:None)
        a.run();b.run()
        self.assertEqual(first.delays,[1,2,4,8]);self.assertEqual(second.delays,[.5,.5])
        self.assertEqual(a.retry.delay,16);self.assertEqual(b.retry.delay,1)

    def test_terminal_auth_stops_without_retrying_or_delivering(self):
        def connect():raise CloudError('unauthorized',401)
        stop=StopAfter(3);delivered=[]
        channel=SnapshotStreamChannel(stop=stop,connect=connect,deliver=delivered.append,
            errors=(CloudError,),terminal=Producer._terminal_connection_error,on_error=lambda _:None)
        channel.run()
        self.assertEqual(stop.delays,[]);self.assertEqual(delivered,[])

    def test_clean_eof_reconnects_without_synthetic_queue_reset(self):
        stop=StopAfter(3);delivered=[];connections=[]
        def connect():
            connections.append(True)
            yield {'revision':len(connections)}
        channel=SnapshotStreamChannel(stop=stop,connect=connect,deliver=delivered.append,
            errors=(CloudError,),terminal=lambda _:False,on_error=lambda _:None)
        channel.run()
        self.assertEqual(delivered,[{'revision':1},{'revision':2},{'revision':3}])
        self.assertEqual(stop.delays,[1,1,1])


class ProducerLaneContractTest(unittest.TestCase):
    config={'role':'fixture','serviceId':'fixture','instanceId':'demo','epoch':'e'}
    def recognize(self,p):
        return p.state.recognize('source',kind='condition',level='default',title='fixture',detail='',scene={'commands':[]})

    def test_downlink_poll_progresses_while_upstream_publish_is_blocked(self):
        publishing=threading.Event();release=threading.Event();snapshot=threading.Event()
        class HTTP:
            def request(self,method,path,body=None):
                if path=='/api/publish':publishing.set();release.wait(3)
                if path=='/api/snapshot':
                    snapshot.set();return {'protocol':1,'revision':2,'items':[],'services':[]}
                return {}
        with tempfile.TemporaryDirectory() as root:
            p=Producer(root,self.config,HTTP(),clock=lambda:100);rec=self.recognize(p)
            p._heart=100
            up=threading.Thread(target=p._run);down=threading.Thread(target=p._poll_snapshots)
            up.start()
            try:
                self.assertTrue(publishing.wait(1));down.start()
                self.assertTrue(snapshot.wait(.5))
                self.assertTrue(up.is_alive())
                self.assertEqual(p.state.records['source']['acked'],0)
                durable=State(p.state.path).records['source']
                self.assertEqual(durable['itemId'],rec['itemId'])
                self.assertEqual(durable['acked'],0)
            finally:
                p._stop.set();release.set();up.join(2)
                if down.ident:down.join(2)

    def test_upstream_publish_progresses_while_downlink_poll_is_blocked(self):
        polling=threading.Event();release=threading.Event();published=threading.Event()
        class HTTP:
            def request(self,method,path,body=None):
                if path=='/api/snapshot':polling.set();release.wait(3)
                if path=='/api/publish':published.set()
                return {}
        with tempfile.TemporaryDirectory() as root:
            p=Producer(root,self.config,HTTP(),clock=lambda:100);self.recognize(p);p._heart=100
            up=threading.Thread(target=p._run);down=threading.Thread(target=p._poll_snapshots)
            down.start()
            try:
                self.assertTrue(polling.wait(1));up.start()
                self.assertTrue(published.wait(.5))
                self.assertTrue(down.is_alive())
            finally:
                p._stop.set();release.set();down.join(2)
                if up.ident:up.join(2)
            self.assertEqual(p.state.records['source']['acked'],1)

    def test_stream_disconnect_reconnect_and_stop_preserve_durable_occurrence(self):
        class HTTP:
            def events(self):raise CloudError('unavailable')
        with tempfile.TemporaryDirectory() as root:
            p=Producer(root,self.config,HTTP(),clock=lambda:100);self.recognize(p)
            before=p.state.path.read_bytes();records=copy.deepcopy(p.state.records)
            p._stop=StopAfter(3);p._events()
            self.assertEqual(p._stop.delays,[1,2,4])
            self.assertEqual(p.state.records,records)
            self.assertEqual(p.state.path.read_bytes(),before)
            self.assertEqual(State(p.state.path).records,records)

    def test_expired_frozen_publish_waits_for_authoritative_absence_before_new_version(self):
        now=[100];bodies=[]
        class HTTP:
            def request(self,method,path,body=None):
                if path=='/api/publish':
                    bodies.append(body)
                    if len(bodies)==1:raise CloudError('unavailable')
                return {}
        with tempfile.TemporaryDirectory() as root:
            p=Producer(root,self.config,HTTP(),clock=lambda:now[0]);self.recognize(p)
            with self.assertRaises(CloudError):p.flush()
            now[0]=200;self.recognize(p);p.flush()
            self.assertEqual(len(bodies),1)
            self.assertEqual(p.state.records['source']['version'],1)
            p.accept({'protocol':1,'revision':1,'serverNow':200000,'items':[],'services':[]})
            p.flush()
            self.assertEqual(len(bodies),2)
            self.assertEqual(bodies[-1]['version'],2)

    def test_snapshot_reconciliation_cannot_apply_old_state_after_new_state(self):
        entered=threading.Event();release=threading.Event();new_done=threading.Event();applied=[]
        with tempfile.TemporaryDirectory() as root:
            p=Producer(root,self.config,None,clock=lambda:100)
            def reconcile(snapshot):
                if snapshot['revision']==1:entered.set();release.wait(2)
                applied.append(snapshot['revision'])
            p.guard.snapshot=reconcile
            old=threading.Thread(target=lambda:p.accept({'protocol':1,'revision':1}))
            def newer():p.accept({'protocol':1,'revision':2});new_done.set()
            new=threading.Thread(target=newer);old.start()
            try:
                self.assertTrue(entered.wait(1));new.start()
                self.assertFalse(new_done.wait(.05),'new reconciliation bypassed its state owner')
            finally:
                release.set();old.join(2)
                if new.ident:new.join(2)
            self.assertEqual(applied,[1,2]);self.assertEqual(p.snapshot['revision'],2)
