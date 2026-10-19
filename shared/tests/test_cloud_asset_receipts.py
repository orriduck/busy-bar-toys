"""Cached upload receipts suppress transfer, never substitute for acceptance."""
import copy
import tempfile
import threading
import unittest
from busybar_shared.cloud import Producer, CloudError


class Server:
    def __init__(self):self.assets=set();self.calls=[];self.producer=None
    def request(self,method,path,body=None):
        self.calls.append((path,copy.deepcopy(body)))
        if path=='/api/assets':
            # HTTP must not inherit a state lock: collection remains independent.
            acquired=threading.Event()
            def collect():
                with self.producer.state.lock:acquired.set()
            worker=threading.Thread(target=collect);worker.start();worker.join(1)
            if not acquired.is_set():raise AssertionError('network request held state lock')
            self.assets.add(body['hash']);return {'hash':body['hash']}
        if path=='/api/publish':
            refs={e['assetHash']for c in body['scene']['commands']for e in c['elements']}
            if not refs<=self.assets:raise CloudError('asset_not_authorized',403)
        return {}


class AssetReceiptTest(unittest.TestCase):
    config={'role':'fixture','serviceId':'fixture','instanceId':'demo','epoch':'e'}
    def producer(self,root,server,now=100,epoch='e'):
        p=Producer(root,{**self.config,'epoch':epoch},server,clock=lambda:now,notify=lambda *a:None)
        server.producer=p;return p
    def recognize(self,p,digests,title):
        scene={'entryDurationMs':0,'commands':[{'offsetMs':0,'elements':[{'id':str(i),'type':'image','assetHash':h}for i,h in enumerate(digests)]}]}
        return p.state.recognize('source',kind='event',level='info',title=title,detail='',scene=scene)

    def test_restart_reuses_common_acked_asset_and_uploads_only_new_content(self):
        with tempfile.TemporaryDirectory()as root:
            s=Server();p=self.producer(root,s)
            common=p.asset('common.png',b'public common');old=p.asset('old.png',b'public old')
            first=self.recognize(p,[common,old],'first');p.flush()
            r=self.producer(root,s,101);s.calls.clear()
            new=r.asset('new.png',b'public next');second=self.recognize(r,[common,new],'second');r.flush()
            self.assertEqual(first['itemId'],second['itemId'])
            self.assertEqual([b['hash']for path,b in s.calls if path=='/api/assets'],[new])
            self.assertEqual(r.state.records['source']['acked'],second['version'])
            self.assertEqual(r.state.records['source']['deadline'],first['deadline'])

    def test_evicted_remote_cache_repairs_exact_body_before_acknowledging(self):
        with tempfile.TemporaryDirectory()as root:
            s=Server();p=self.producer(root,s)
            digest=p.asset('a.png',b'public common');self.recognize(p,[digest],'first');p.flush()
            r=self.producer(root,s,101);s.assets.clear();s.calls.clear()
            pending=self.recognize(r,[digest],'changed');self.assertLess(r.state.records['source']['acked'],pending['version'])
            r.flush()
            self.assertEqual([path for path,_ in s.calls[:3]],['/api/publish','/api/assets','/api/publish'])
            bodies=[b for path,b in s.calls if path=='/api/publish'];self.assertEqual(bodies[0],bodies[1])
            self.assertEqual(r.state.records['source']['acked'],pending['version'])

    def test_expired_future_or_other_epoch_receipts_do_not_skip_upload(self):
        for stamp,epoch in ((-1700,'e'),(101,'e'),(100,'other')):
            with self.subTest(stamp=stamp,epoch=epoch),tempfile.TemporaryDirectory()as root:
                s=Server();p=self.producer(root,s);digest=p.asset('a.png',b'public data')
                self.recognize(p,[digest],'first');p.flush()
                p.state.data['assets'][digest]['uploadedAt']=stamp;p.state.save()
                r=self.producer(root,s,100,epoch)
                self.assertNotIn(digest,r._assets)
                s.calls.clear();self.recognize(r,[digest],'next');r.flush()
                self.assertTrue(any(path=='/api/assets'for path,_ in s.calls))
