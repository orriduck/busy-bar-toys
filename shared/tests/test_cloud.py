"""Cloud producer safety, durable delivery and independent urgent fallback."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from busybar_shared import cloud


class CloudTest(unittest.TestCase):
    def test_url_and_scoped_setup_metadata(self):
        for bad in ('http://example.com', 'https://u:p@host', 'https://host/?x=1', 'https://host/#x', 'https://host/path'):
            with self.assertRaises(ValueError): cloud.base_url(bad)
        self.assertEqual(cloud.base_url('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787')
        with tempfile.TemporaryDirectory() as directory:
            stored=[]
            class HTTP:
                def __init__(self,url,secret): self.secret=secret
                def request(self,*args): return {'protocol':1,'services':[{'id':'agent','template':'agent','epoch':'stable','epochExpiresAt':9999999999999}]}
            config=cloud.setup(Path(directory),'http://localhost:8787','agent',secret='private',store=lambda role,value:stored.append((role,value)),transport=HTTP)
            again=cloud.load_config(Path(directory),'agent')
            self.assertEqual(again,config)
            self.assertEqual(stored,[('agent','private')])
            self.assertNotIn('private', (Path(directory)/'cloud-agent.json').read_text())
            self.assertEqual((Path(directory)/'cloud-agent.json').stat().st_mode & 0o777,0o600)
            self.assertEqual(again['epoch'],'stable')

    def test_occurrences_survive_restart_and_tombstones_do_not_revive(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'state.json'
            state=cloud.State(path,clock=lambda:100)
            first=state.recognize('source:id',kind='condition',level='urgent',title='A',detail='',scene={'commands':[{'offsetMs':0,'elements':[]}], 'entryDurationMs':0})
            recovered=cloud.State(path,clock=lambda:101)
            self.assertEqual(recovered.records['source:id']['itemId'],first['itemId'])
            recovered.tombstone(first['itemId'],'manual')
            self.assertIsNone(recovered.recognize('source:id',kind='condition',level='urgent',title='A',detail='',scene={}))
            recovered.clear('source:id')
            new=recovered.recognize('source:id',kind='condition',level='urgent',title='A',detail='',scene={})
            self.assertNotEqual(new['itemId'], first['itemId'])

    def test_watchdog_proofs_expire_without_sse_and_restart_does_not_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            now=[100.0]; notices=[]
            state=cloud.State(Path(directory)/'state.json',clock=lambda:now[0])
            rec=state.recognize('urgent',kind='condition',level='urgent',title='Alert',detail='Detail',scene={})
            config={'serviceId':'notifier','instanceId':'mac','epoch':'e'}
            guard=cloud.Watchdog(state,config,notify=lambda *v:notices.append(v),clock=lambda:now[0])
            key=json.dumps(['notifier','mac',rec['itemId']],separators=(',',':'))
            snap={'revision':2,'generation':3,'health':{'status':'healthy'},'services':[{'id':'notifier','config':{'enabled':True}}], 'items':[{'itemKey':key,'itemId':rec['itemId'],'instanceId':'mac','version':1,'queueProof':{'revision':2,'itemKey':key,'controller':{'itemKey':'other','generation':3},'validUntil':110000}}], 'displaying':{'itemKey':'other','generation':3,'confirmedValidUntil':110000}}
            guard.snapshot(snap)
            now[0]=109; guard.check(); self.assertEqual(notices,[])
            now[0]=111; guard.check(); self.assertEqual(notices,[])
            state2=cloud.State(state.path,clock=lambda:now[0]); guard2=cloud.Watchdog(state2,config,notify=lambda *v:notices.append(v),clock=lambda:now[0])
            now[0]=120; guard2.check(); self.assertEqual(len(notices),1)
            guard2.check(); self.assertEqual(len(notices),1)

    def test_action_is_recorded_before_callback_and_never_repeats_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            state=cloud.State(Path(directory)/'state.json',clock=lambda:100)
            rec=state.recognize('a',kind='condition',level='urgent',title='A',detail='',scene={},actionKeys=['primary'])
            config={'serviceId':'notifier','instanceId':'mac','epoch':'e'}
            key=json.dumps(['notifier','mac',rec['itemId']],separators=(',',':'))
            action={'id':'act','serviceId':'notifier','instanceId':'mac','itemId':rec['itemId'],'itemKey':key,'generation':2,'actionKey':'primary','status':'pending','expiresAt':110000,'version':1}
            snapshot={'generation':2,'selected':key,'items':[{'itemKey':key,'itemId':rec['itemId'],'version':1,'actionKeys':['primary']}], 'actions':[action]}
            calls=[]
            executor=cloud.Actions(state,config,clock=lambda:100)
            executor.callbacks[rec['itemId']]={'primary':lambda:calls.append(json.loads(state.path.read_text())['actions']['act']['status'])}
            executor.accept(snapshot)
            self.assertEqual(calls,['running'])
            again=cloud.Actions(cloud.State(state.path),config,clock=lambda:100)
            again.callbacks=executor.callbacks; again.accept(snapshot)
            self.assertEqual(calls,['running'])
            self.assertEqual(state.data['actions']['act']['status'],'succeeded')

    def test_exact_publish_body_is_retried_after_lost_ack(self):
        with tempfile.TemporaryDirectory() as directory:
            now=[100.0]
            class HTTP:
                def __init__(self): self.calls=[]
                def request(self,method,path,body=None):
                    if path=='/api/publish':
                        self.calls.append(body)
                        if len(self.calls)==1: raise cloud.CloudError()
                    return {}
            http=HTTP(); producer=cloud.Producer(directory,{'role':'agent','serviceId':'agent','instanceId':'mac','epoch':'e'},http,clock=lambda:now[0])
            producer.state.recognize('a',kind='agent',level='info',title='A',detail='',scene={'entryDurationMs':0,'commands':[{'offsetMs':0,'elements':[]}]})
            with self.assertRaises(cloud.CloudError): producer.flush()
            now[0]=105
            producer.state.recognize('a',kind='agent',level='info',title='A',detail='',scene={'entryDurationMs':0,'commands':[{'offsetMs':0,'elements':[]}]})
            producer.flush()
            self.assertEqual(http.calls[0],http.calls[1])

    def test_reconnect_after_expired_unacknowledged_publish_advances_version(self):
        with tempfile.TemporaryDirectory() as directory:
            now=[100.0]
            class HTTP:
                def __init__(self): self.calls=[]
                def request(self,method,path,body=None):
                    if path=='/api/publish':
                        self.calls.append(body)
                        if len(self.calls)==1: raise cloud.CloudError()
                    return {}
            http=HTTP(); producer=cloud.Producer(directory,{'role':'agent','serviceId':'a','instanceId':'mac','epoch':'e'},http,clock=lambda:now[0])
            content=dict(kind='agent',level='info',title='A',detail='',scene={'entryDurationMs':0,'commands':[{'offsetMs':0,'elements':[]}]})
            producer.state.recognize('a',**content)
            with self.assertRaises(cloud.CloudError): producer.flush()
            now[0]=200; producer.state.recognize('a',**content); producer.flush()
            self.assertEqual(http.calls[-1]['version'],2)
            self.assertGreater(http.calls[-1]['validUntil'],200000)
            self.assertEqual(http.calls[-1]['firstRecognizedAt'],100000)

    def test_recurrence_keeps_old_end_in_durable_outbox(self):
        with tempfile.TemporaryDirectory() as directory:
            state=cloud.State(Path(directory)/'state.json',clock=lambda:100)
            first=state.recognize('a',kind='condition',level='info',title='A',detail='',scene={})
            state.clear('a'); state.recognize('a',kind='condition',level='info',title='B',detail='',scene={})
            again=cloud.State(state.path)
            self.assertIn(first['itemId'],again.data['ends'])

    def test_own_old_confirmation_cannot_cover_new_content_version(self):
        with tempfile.TemporaryDirectory() as directory:
            now=[100.0]; notices=[]; state=cloud.State(Path(directory)/'state.json',clock=lambda:now[0])
            rec=state.recognize('u',kind='condition',level='urgent',title='A',detail='',scene={})
            guard=cloud.Watchdog(state,{'instanceId':'mac','serviceId':'n'},clock=lambda:now[0],notify=lambda *a:notices.append(a))
            snap={'revision':1,'generation':1,'health':{'status':'healthy'},'displaying':{'itemKey':'own','generation':1,'confirmedValidUntil':200000},'items':[{'itemId':rec['itemId'],'instanceId':'mac','itemKey':'own','version':1}]}
            guard.snapshot(snap)
            now[0]=110; guard.check()
            self.assertEqual(len(notices),1,'a display owner without versioned admission cannot defer fallback')

    def test_explicit_offline_backend_triggers_unpublished_urgent_early(self):
        with tempfile.TemporaryDirectory() as directory:
            notices=[]; state=cloud.State(Path(directory)/'state.json',clock=lambda:100)
            state.recognize('u',kind='condition',level='urgent',title='A',detail='',scene={})
            guard=cloud.Watchdog(state,{'instanceId':'mac','serviceId':'n'},clock=lambda:100,notify=lambda *a:notices.append(a))
            guard.snapshot({'revision':1,'health':{'status':'offline'},'items':[]})
            guard.check(); self.assertEqual(len(notices),1)

    def test_owner_exit_shortens_proof_deadline_only_once(self):
        with tempfile.TemporaryDirectory() as directory:
            now=[100.0]; notices=[]; state=cloud.State(Path(directory)/'state.json',clock=lambda:now[0])
            rec=state.recognize('a',kind='condition',level='urgent',title='A',detail='',scene={})
            rec=state.records['a']; rec['deadline']=170000; rec['proofUntil']=160000; state.save()
            guard=cloud.Watchdog(state,{'instanceId':'mac','serviceId':'n'},clock=lambda:now[0],notify=lambda *v:notices.append(v))
            item={'instanceId':'mac','itemId':rec['itemId'],'itemKey':'a','version':1}
            snap={'revision':3,'items':[item],'health':{'status':'unknown'}}
            guard.snapshot(snap); now[0]=105; snap['revision']=4; guard.snapshot(snap)
            now[0]=110; guard.check()
            self.assertEqual(len(notices),1)

    def test_local_asset_lru_is_bounded_and_preserves_active_references(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=cloud.Producer(directory,{'role':'agent','serviceId':'a','instanceId':'mac','epoch':'e'},object(),clock=lambda:100)
            pinned=producer.asset('one.png',b'one')
            producer.state.recognize('a',kind='agent',level='info',title='A',detail='',scene={'commands':[{'offsetMs':0,'elements':[{'id':'image','type':'image','assetHash':pinned}]}]})
            with patch('busybar_shared.cloud.LOCAL_ASSET_COUNT',3):
                for index in range(8): producer.asset('extra.png',str(index).encode())
            self.assertLessEqual(len(producer.state.data['assets']),3)
            self.assertIn(pinned,producer.state.data['assets'])

    def test_tombstone_compacts_content_but_keeps_replay_protection(self):
        with tempfile.TemporaryDirectory() as directory:
            state=cloud.State(Path(directory)/'state.json',clock=lambda:100)
            rec=state.recognize('a',kind='condition',level='urgent',title='A',detail='private',scene={'large':'x'*10000})
            state.tombstone(rec['itemId'],'cleared')
            compact=state.records['a']
            self.assertNotIn('scene',compact); self.assertNotIn('detail',compact)
            self.assertEqual(compact['itemId'],rec['itemId'])
            self.assertIsNone(state.recognize('a',kind='condition',level='urgent',title='A',detail='',scene={}))

    def test_stop_does_not_turn_manual_tombstone_into_source_clear(self):
        with tempfile.TemporaryDirectory() as directory:
            class HTTP:
                def request(self,*args): return {}
            producer=cloud.Producer(directory,{'role':'notifier','serviceId':'n','instanceId':'mac','epoch':'e'},HTTP(),clock=lambda:100)
            record=producer.state.recognize('a',kind='condition',level='urgent',title='A',detail='',scene={})
            producer.state.tombstone(record['itemId'],'cleared')
            producer.stop()
            state=cloud.State(producer.state.path,clock=lambda:101)
            self.assertIsNone(state.recognize('a',kind='condition',level='urgent',title='A',detail='',scene={}))

    def test_wall_clock_rollback_cannot_delay_watchdog(self):
        with tempfile.TemporaryDirectory() as directory:
            wall=[100.0]; mono=[10.0]; notices=[]
            state=cloud.State(Path(directory)/'state.json',clock=lambda:wall[0])
            state.recognize('u',kind='condition',level='urgent',title='A',detail='',scene={})
            guard=cloud.Watchdog(state,{'instanceId':'mac','serviceId':'n'},clock=lambda:wall[0],monotonic=lambda:mono[0],notify=lambda *a:notices.append(a))
            wall[0]=50; mono[0]=21; guard.check()
            self.assertEqual(len(notices),1)

    def test_os_notification_failure_is_durable_and_sanitized(self):
        with tempfile.TemporaryDirectory() as directory:
            now=[100.0]; state=cloud.State(Path(directory)/'state.json',clock=lambda:now[0])
            state.recognize('u',kind='condition',level='urgent',title='A',detail='',scene={})
            def failed(*args): raise RuntimeError('private stderr or credential')
            guard=cloud.Watchdog(state,{'instanceId':'mac','serviceId':'n'},clock=lambda:now[0],notify=failed)
            now[0]=111; guard.check()
            diagnostic=cloud.State(state.path).data['notificationStatus']
            self.assertEqual(diagnostic['status'],'failed')
            self.assertNotIn('private',json.dumps(diagnostic))

    def test_expired_urgent_tombstone_preserves_fallback_and_prevents_replay(self):
        for reason in ('expired','epoch-expired'):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as directory:
                now=[100.0]; notices=[]
                config={'role':'notifier','serviceId':'n','instanceId':'m','epoch':'e'}
                producer=cloud.Producer(directory,config,object(),clock=lambda:now[0],notify=lambda *a:notices.append(a))
                record=producer.state.recognize('source:x',kind='condition',level='urgent',title='Urgent page',detail='Keep this detail',scene={})
                key=json.dumps(['n','m',record['itemId']],separators=(',',':'))
                now[0]=105
                producer.accept({'protocol':1,'revision':2,'health':{'status':'unknown'},'services':[{'id':'n','config':{'enabled':True}}], 'items':[], 'tombstones':[{'itemKey':key,'version':1,'reason':reason}]})
                recovered=cloud.State(producer.state.path,clock=lambda:now[0])
                self.assertIsNone(recovered.recognize('source:x',kind='condition',level='urgent',title='Urgent page',detail='',scene={}))
                guard=cloud.Watchdog(recovered,config,clock=lambda:now[0],notify=lambda *a:notices.append(a))
                now[0]=111; guard.check(); guard.check()
                self.assertEqual(notices,[('Urgent page','Keep this detail')])
                self.assertNotIn('detail',recovered.records['source:x'])

    def test_expired_urgent_source_clear_still_suppresses_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            now=[100.0]; notices=[]; state=cloud.State(Path(directory)/'state.json',clock=lambda:now[0])
            record=state.recognize('x',kind='condition',level='urgent',title='A',detail='B',scene={})
            guard=cloud.Watchdog(state,{'serviceId':'n','instanceId':'m'},clock=lambda:now[0],notify=lambda *a:notices.append(a))
            state.tombstone(record['itemId'],'expired'); state.clear('x')
            now[0]=111; guard.check(); self.assertEqual(notices,[])

    def test_sleep_wall_advance_expires_proof_with_little_monotonic_progress(self):
        for restart in (False,True):
            with self.subTest(restart=restart), tempfile.TemporaryDirectory() as directory:
                wall=[100.0]; mono=[10.0]; notices=[]
                state=cloud.State(Path(directory)/'state.json',clock=lambda:wall[0])
                state.recognize('u',kind='condition',level='urgent',title='A',detail='',scene={})
                guard=cloud.Watchdog(state,{'serviceId':'n','instanceId':'m'},clock=lambda:wall[0],monotonic=lambda:mono[0],notify=lambda *a:notices.append(a))
                state.records['u']['deadline']=170000; state.save()
                wall[0]=1000; mono[0]=11
                if restart:
                    state=cloud.State(state.path,clock=lambda:wall[0])
                    guard=cloud.Watchdog(state,{'serviceId':'n','instanceId':'m'},clock=lambda:wall[0],monotonic=lambda:mono[0],notify=lambda *a:notices.append(a))
                guard.check(); self.assertEqual(len(notices),1)
                state.recognize('next',kind='condition',level='urgent',title='Next',detail='',scene={})
                wall[0]=900; mono[0]=22; guard.check()
                self.assertEqual(len(notices),2,'UTC advance followed by rollback must still allow monotonic progress')

    def test_stale_action_version_or_business_target_never_runs_new_callback(self):
        for version,business in ((1,'new-target'),(2,'old-target')):
            with self.subTest(version=version,business=business), tempfile.TemporaryDirectory() as directory:
                state=cloud.State(Path(directory)/'state.json',clock=lambda:100)
                state.recognize('a',kind='condition',level='urgent',title='Old',detail='',scene={},businessId='old-target')
                rec=state.recognize('a',kind='condition',level='urgent',title='New',detail='',scene={},businessId='new-target')
                config={'serviceId':'n','instanceId':'m'}; calls=[]
                action={'id':'stale','serviceId':'n','instanceId':'m','itemId':rec['itemId'],'itemKey':'key','generation':2,'version':version,'businessId':business,'actionKey':'primary','status':'pending','expiresAt':110000}
                snapshot={'generation':2,'selected':'key','items':[{'itemId':rec['itemId'],'itemKey':'key','version':2,'actionKeys':['primary']}],'actions':[action]}
                executor=cloud.Actions(state,config,clock=lambda:100)
                executor.callbacks[rec['itemId']]={'primary':lambda:calls.append('new callback')}
                executor.accept(snapshot)
                self.assertEqual(calls,[])
                self.assertEqual(state.data['actions']['stale']['status'],'failed')

    def test_bounded_sse_full_snapshot(self):
        raw=[b'event: snapshot\n',b'data: {"revision":1}\n',b'\n']
        self.assertEqual(list(cloud.parse_sse(raw)),[{'revision':1}])
        with self.assertRaises(cloud.CloudError): list(cloud.parse_sse([b'data: '+b'x'*cloud.MAX_RESPONSE+b'\n']))

class CloudThreadTest(unittest.TestCase):
    def test_watchdog_runs_while_publish_and_sse_are_blocked(self):
        import threading
        now=[100.0]; entered=threading.Event(); release=threading.Event(); notice=threading.Event()
        class SlowHTTP:
            def request(self,*args):
                entered.set(); release.wait(3); return {}
            def events(self):
                release.wait(3)
                if False: yield None
        with tempfile.TemporaryDirectory() as directory:
            producer=cloud.Producer(directory,{'role':'notifier','serviceId':'n','instanceId':'mac','epoch':'e'},SlowHTTP(),clock=lambda:now[0],notify=lambda *v:notice.set())
            producer.state.recognize('urgent',kind='condition',level='urgent',title='A',detail='',scene={})
            producer.start()
            try:
                self.assertTrue(entered.wait(1))
                now[0]=111
                self.assertTrue(notice.wait(1), 'network I/O must not block urgent fallback')
            finally:
                release.set(); producer.stop()

    def test_keychain_secret_is_only_in_stdin_and_errors_are_sanitized(self):
        from types import SimpleNamespace
        with patch('busybar_shared.cloud.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout='')) as run:
            cloud.keychain('agent','secret-value')
            self.assertNotIn('secret-value',run.call_args.args[0])
            self.assertEqual(run.call_args.kwargs['input'],'secret-value')
        with patch('busybar_shared.cloud.subprocess.run',return_value=SimpleNamespace(returncode=1,stdout='secret-value')):
            with self.assertRaises(cloud.CloudError) as error: cloud.keychain('agent')
            self.assertNotIn('secret-value',str(error.exception))

    def test_interrupted_action_is_unknown_without_repeating_callback(self):
        with tempfile.TemporaryDirectory() as directory:
            state=cloud.State(Path(directory)/'state.json')
            state.data['actions']['action']={'status':'running','sent':False,'outbox':['running']}; state.save()
            recovered=cloud.Actions(cloud.State(state.path),{'serviceId':'n','instanceId':'mac'})
            self.assertEqual(recovered.state.data['actions']['action']['status'],'unknown')
            self.assertEqual(recovered.state.data['actions']['action']['outbox'],['unknown'])

    def test_manual_pause_and_disabled_service_suppress_fallback(self):
        for disabled in (False,True):
            with self.subTest(disabled=disabled), tempfile.TemporaryDirectory() as directory:
                now=[100.0]; notices=[]; state=cloud.State(Path(directory)/'state.json',clock=lambda:now[0])
                rec=state.recognize('u',kind='condition',level='urgent',title='A',detail='',scene={})
                guard=cloud.Watchdog(state,{'instanceId':'mac','serviceId':'n'},clock=lambda:now[0],notify=lambda *a:notices.append(a))
                guard.snapshot({'revision':1,'items':[{'itemId':rec['itemId'],'instanceId':'mac','state':'paused' if not disabled else 'waiting'}], 'services':[{'id':'n','config':{'enabled':not disabled}}]})
                now[0]=200; guard.check(); self.assertEqual(notices,[])

    def test_healthy_queue_proof_renewal_suppresses_indefinitely_but_replay_cannot(self):
        with tempfile.TemporaryDirectory() as directory:
            now=[100.0]; notices=[]; state=cloud.State(Path(directory)/'state.json',clock=lambda:now[0])
            rec=state.recognize('u',kind='condition',level='urgent',title='A',detail='',scene={})
            guard=cloud.Watchdog(state,{'instanceId':'mac','serviceId':'n'},clock=lambda:now[0],notify=lambda *a:notices.append(a))
            def snapshot(revision,until):
                return {'revision':revision,'generation':7,'health':{'status':'healthy'},'displaying':{'itemKey':'other','generation':7,'confirmedValidUntil':until}, 'items':[{'itemId':rec['itemId'],'itemKey':'own','instanceId':'mac','version':1,'queueProof':{'revision':revision,'itemKey':'own','controller':{'itemKey':'other','generation':7},'validUntil':until}}]}
            for i in range(10):
                now[0]=100+i*20; guard.snapshot(snapshot(i+1,int((now[0]+30)*1000))); guard.check()
            self.assertEqual(notices,[])
            frozen=snapshot(10,310000)
            now[0]=319; guard.snapshot(frozen); guard.check(); self.assertEqual(notices,[])
            now[0]=320; guard.snapshot(frozen); guard.check(); self.assertEqual(len(notices),1)
