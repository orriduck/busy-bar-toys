"""Fresh scoped responses avoid redundant WAN polls, never renew display proof."""
import tempfile
import unittest
from unittest.mock import patch
from busybar_shared.cloud import Producer,CloudError


class SnapshotPollingTest(unittest.TestCase):
    config={'role':'fixture','serviceId':'fixture','instanceId':'demo','epoch':'e'}
    def snapshot(self,now=100000,revision=1):
        return {'protocol':1,'serverNow':now,'revision':revision,'services':[],'items':[]}

    def test_fresh_received_snapshot_publishes_without_a_preceding_get(self):
        clock=[100.0];calls=[]
        class HTTP:
            def request(self,method,path,body=None):calls.append(path);return {}
        class Stop:
            def is_set(self):return False
            def wait(self,_):return True
        with tempfile.TemporaryDirectory()as root,patch('busybar_shared.cloud.time.monotonic',side_effect=lambda:clock[0]):
            p=Producer(root,self.config,HTTP(),clock=lambda:clock[0]);p.accept(self.snapshot())
            rec=p.state.recognize('a',kind='event',level='info',title='public',detail='',
                scene={'entryDurationMs':0,'commands':[{'offsetMs':0,'elements':[]}]})
            p._stop=Stop();p._run()
            self.assertEqual(calls[0],'/api/publish');self.assertNotIn('/api/snapshot',calls)
            self.assertEqual(p.state.records['a']['acked'],rec['version'])

    def test_startup_and_silent_stream_poll_within_five_seconds(self):
        clock=[100.0];calls=[];outer=self
        class HTTP:
            def request(self,method,path,body=None):
                calls.append((path,clock[0]));return outer.snapshot(round(clock[0]*1000),round(clock[0]))
        class Stop:
            loops=0
            def is_set(self):return self.loops>=12
            def wait(self,seconds):clock[0]+=seconds;self.loops+=1;return self.is_set()
        with tempfile.TemporaryDirectory()as root,patch('busybar_shared.cloud.time.monotonic',side_effect=lambda:clock[0]):
            p=Producer(root,self.config,HTTP(),clock=lambda:clock[0]);p._heart=100;p._stop=Stop();p._poll_snapshots()
            self.assertEqual([now for path,now in calls if path=='/api/snapshot'],[100,105])

    def test_replayed_invalid_or_backward_clock_snapshots_cannot_extend_reuse(self):
        clock=[100.0]
        with tempfile.TemporaryDirectory()as root,patch('busybar_shared.cloud.time.monotonic',side_effect=lambda:clock[0]):
            p=Producer(root,self.config,None,clock=lambda:clock[0]);p.accept(self.snapshot())
            self.assertFalse(p._snapshot_due())
            clock[0]=104;p.accept(self.snapshot(revision=2)) # Same server time is not new evidence.
            p.accept(self.snapshot(now=110000,revision=1)) # Older revision is ignored.
            clock[0]=105;self.assertTrue(p._snapshot_due())
            invalid=self.snapshot(now=111000,revision=3);invalid['services']=[{'id':'foreign'}]
            with self.assertRaises(CloudError):p.accept(invalid)
            self.assertTrue(p._snapshot_due())
            clock[0]=99;self.assertTrue(p._snapshot_due())

    def test_fresh_snapshots_do_not_throttle_existing_heartbeat_schedule(self):
        clock=[100.0];calls=[]
        class HTTP:
            def request(self,method,path,body=None):calls.append(path);return {}
        with tempfile.TemporaryDirectory()as root,patch('busybar_shared.cloud.time.monotonic',side_effect=lambda:clock[0]):
            p=Producer(root,self.config,HTTP(),clock=lambda:clock[0]);p.flush()
            clock[0]=104;p.accept(self.snapshot(now=104000));p.flush()
            self.assertFalse(p._snapshot_due());self.assertEqual(calls,['/api/heartbeat'])
            clock[0]=105;p.flush();self.assertEqual(calls,['/api/heartbeat','/api/heartbeat'])

    def test_fresh_snapshots_do_not_suppress_urgent_fallback_without_display_proof(self):
        clock=[100.0];notices=[]
        with tempfile.TemporaryDirectory()as root,patch('busybar_shared.cloud.time.monotonic',side_effect=lambda:clock[0]):
            p=Producer(root,self.config,None,clock=lambda:clock[0],notify=lambda *args:notices.append(args))
            p.state.recognize('u',kind='condition',level='urgent',title='public',detail='',scene={})
            for n in range(11):
                clock[0]=100+n;p.accept(self.snapshot(round(clock[0]*1000),n+1));p.guard.check()
            self.assertEqual(len(notices),1)
