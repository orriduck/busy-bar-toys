"""Cloud producer safety, durable delivery and independent urgent fallback."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from busybar_shared import cloud


class CloudTest(unittest.TestCase):
    def test_state_exact_byte_limit_round_trip_and_overflow_preserve_prior_file(self):
        with tempfile.TemporaryDirectory() as directory:
            state=cloud.State(Path(directory)/'state.json')
            state.data['sample']=['a','b','non-ascii-\u00e9']
            raw=json.dumps(state.data,separators=(',',':'),allow_nan=False).encode()
            with patch.object(cloud,'LOCAL_STATE_BYTES',len(raw)):
                state.save()
                self.assertEqual(state.path.read_bytes(),raw)
                self.assertEqual(cloud.State(state.path).data,state.data)
                self.assertEqual(state.path.stat().st_mode&0o777,0o600)
                state.data['sample'].append('overflow')
                with self.assertRaisesRegex(cloud.CloudError,'local_state_capacity'):state.save()
                self.assertEqual(state.path.read_bytes(),raw)

    def test_failed_state_fsync_keeps_durable_file_and_removes_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            state=cloud.State(Path(directory)/'state.json');state.save()
            before=state.path.read_bytes();state.data['new']='not durable'
            with patch.object(cloud.os,'fsync',side_effect=OSError('fixture')):
                with self.assertRaises(OSError):state.save()
            self.assertEqual(state.path.read_bytes(),before)
            self.assertEqual([p.name for p in Path(directory).iterdir()],['state.json'])

    def test_indexed_tombstone_checks_replaced_occurrences_and_preserves_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            state=cloud.State(Path(directory)/'state.json',clock=lambda:100)
            old=state.recognize('source',kind='condition',level='urgent',title='Old',detail='',scene={})
            state.clear('source')
            new=state.recognize('source',kind='condition',level='urgent',title='New',detail='',scene={})
            self.assertFalse(state.tombstone(old['itemId'],'expired',record_keys=['source']))
            self.assertNotIn('tombstone',state.records['source'])
            self.assertEqual(state.records['source']['itemId'],new['itemId'])
            state.records['duplicate']=state.records['source'].copy()
            state.save(); durable_before=state.path.read_bytes()
            records_before=json.loads(json.dumps(state.records))
            with patch.object(state,'save',side_effect=OSError('fixture')):
                with self.assertRaises(OSError):
                    state.tombstone(new['itemId'],'expired',record_keys=['source','duplicate'])
            self.assertEqual(state.records,records_before)
            self.assertEqual(state.path.read_bytes(),durable_before)
            self.assertTrue(state.tombstone(new['itemId'],'expired',record_keys=['source','duplicate']))
            for key in ('source','duplicate'):
                self.assertEqual(state.records[key]['tombstone'],'expired')
                self.assertTrue(state.records[key]['fallbackPending'])
            self.assertEqual(cloud.State(state.path).records,state.records)

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

    def test_new_roles_share_instance_without_rekeying_existing_roles(self):
        class HTTP:
            def __init__(self,url,secret): self.role=secret
            def request(self,*args):
                return {'protocol':1,'services':[{'id':self.role,'template':self.role,'epoch':'stable'}]}
        with tempfile.TemporaryDirectory() as directory:
            def setup(role,instance=None):
                return cloud.setup(directory,'http://localhost:8787',role,instance=instance,secret=role,store=lambda *args:None,transport=HTTP)
            agent=setup('agent')
            notifier=setup('notifier')
            self.assertEqual(agent['instanceId'],notifier['instanceId'])
            explicit=setup('notifier','chosen-id')
            self.assertEqual(explicit['instanceId'],'chosen-id')
            self.assertEqual(setup('notifier')['instanceId'],'chosen-id')
            self.assertEqual(setup('agent')['instanceId'],agent['instanceId'])

    def test_configured_fallback_survives_setup_and_producer_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            now=[100.0]; notices=[]
            class HTTP:
                def __init__(self,*args): pass
                def request(self,*args): return {'protocol':1,'services':[{'id':'notifier','template':'notifier','epoch':'e'}]}
            config=cloud.setup(directory,'http://localhost:8787','notifier',secret='private',fallback_seconds=17,store=lambda *a:None,transport=HTTP)
            self.assertEqual(cloud.load_config(directory,'notifier')['fallbackSeconds'],17)
            producer=cloud.Producer(directory,config,HTTP(),clock=lambda:now[0],notify=lambda *a:notices.append(a))
            record=producer.state.recognize('u',kind='condition',level='urgent',title='A',detail='',scene={})
            self.assertEqual(record['deadline'],117000)
            now[0]=110
            recovered=cloud.Producer(directory,cloud.load_config(directory,'notifier'),HTTP(),clock=lambda:now[0],notify=lambda *a:notices.append(a))
            now[0]=116; recovered.guard.check(); self.assertEqual(notices,[])
            now[0]=117; recovered.guard.check(); self.assertEqual(len(notices),1)

    def test_fallback_bounds_and_old_metadata_default(self):
        with tempfile.TemporaryDirectory() as directory:
            class HTTP:
                def __init__(self,*args): pass
                def request(self,*args): return {'protocol':1,'services':[{'id':'agent','template':'agent','epoch':'e'}]}
            for value in (0,301,-1,True,1.5,'17'):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    cloud.setup(directory,'http://localhost:8787','agent',secret='private',fallback_seconds=value,store=lambda *a:None,transport=HTTP)
            config=cloud.setup(directory,'http://localhost:8787','agent',secret='private',store=lambda *a:None,transport=HTTP)
            self.assertEqual(config['fallbackSeconds'],10)
            path=Path(directory)/'cloud-agent.json'
            config.pop('fallbackSeconds'); cloud.atomic_json(path,config)
            self.assertEqual(cloud.load_config(directory,'agent')['fallbackSeconds'],10)
            for value in (0,301,True,'17'):
                config['fallbackSeconds']=value; cloud.atomic_json(path,config)
                with self.subTest(saved=value), self.assertRaises(cloud.CloudError): cloud.load_config(directory,'agent')

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

    def test_sender_declares_each_messages_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            class HTTP:
                def __init__(self): self.calls=[]
                def request(self,method,path,body=None):
                    if path=='/api/publish': self.calls.append(body)
                    return {}
            http=HTTP()
            producer=cloud.Producer(directory,{'role':'agent','serviceId':'agent','instanceId':'mac','epoch':'e'},http,clock=lambda:100)
            cases=[('agent','info',None,'source'),('condition','urgent',None,'source'),('event','info',None,'finite'),('condition','info','source','source'),('agent','info','finite','finite')]
            for index,(kind,level,declared,expected) in enumerate(cases):
                extra={} if declared is None else {'exit':declared}
                producer.state.recognize(str(index),kind=kind,level=level,title='A',detail='',scene={'commands':[]},**extra)
            producer.flush()
            self.assertEqual([body.get('exit') for body in http.calls],[case[3] for case in cases])

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
            now[0]=200; producer.state.recognize('a',**content)
            producer.accept({'protocol':1,'revision':1,'serverNow':200000,'services':[],'items':[]})
            producer.flush()
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

    def test_tombstone_saves_only_record_transitions(self):
        with tempfile.TemporaryDirectory() as directory:
            state=cloud.State(Path(directory)/'state.json',clock=lambda:100)
            record=state.recognize('a',kind='condition',level='urgent',title='A',detail='B',scene={})
            with patch.object(state,'save',wraps=state.save) as save:
                self.assertFalse(state.tombstone('missing','expired'))
                self.assertEqual(save.call_count,0)
                self.assertTrue(state.tombstone(record['itemId'],'expired'))
                self.assertEqual(save.call_count,1)
                self.assertFalse(state.tombstone(record['itemId'],'expired'))
                self.assertEqual(save.call_count,1)
                self.assertTrue(state.tombstone(record['itemId'],'cleared'))
                self.assertEqual(save.call_count,2)
                self.assertFalse(state.tombstone(record['itemId'],'cleared'))
                self.assertEqual(save.call_count,2)
            recovered=cloud.State(state.path)
            self.assertEqual(recovered.records['a']['tombstone'],'cleared')
            self.assertEqual(recovered.records['a']['acked'],record['version'])
            self.assertNotIn('title',recovered.records['a'])

    def test_same_reason_tombstone_repairs_legacy_record_before_becoming_noop(self):
        with tempfile.TemporaryDirectory() as directory:
            state=cloud.State(Path(directory)/'state.json',clock=lambda:100)
            record=state.recognize('a',kind='condition',level='urgent',title='A',detail='B',scene={})
            state.records['a'].update(tombstone='expired',acked=0,ending=True,fallbackPending=False)
            state.save()
            with patch.object(state,'save',wraps=state.save) as save:
                self.assertTrue(state.tombstone(record['itemId'],'expired'))
                self.assertEqual(save.call_count,1)
                repaired=cloud.State(state.path).records['a']
                self.assertEqual(repaired['acked'],record['version'])
                self.assertNotIn('ending',repaired)
                self.assertNotIn('scene',repaired)
                self.assertTrue(repaired['fallbackPending'])
                self.assertEqual((repaired['title'],repaired['detail']),('A','B'))
                self.assertFalse(state.tombstone(record['itemId'],'expired'))
                self.assertEqual(save.call_count,1)

    def test_replayed_tombstone_snapshots_only_save_watchdog_and_do_not_repeat_callbacks(self):
        with tempfile.TemporaryDirectory() as directory:
            config={'role':'agent','serviceId':'a','instanceId':'mac','epoch':'e'}
            producer=cloud.Producer(directory,config,object(),clock=lambda:100)
            tombs=[]; transitions=[]
            for index in range(3):
                record=producer.state.recognize(str(index),kind='agent',level='info',title='A',detail='',scene={})
                key=json.dumps(['a','mac',record['itemId']],separators=(',',':'))
                tombs.append({'itemKey':key,'version':record['version'],'reason':'cleared'})
            def transitioned(item_id,reason):
                saved=cloud.State(producer.state.path)
                record=next(r for r in saved.records.values() if r['itemId']==item_id)
                self.assertEqual(record['tombstone'],reason,'receipt must be durable before callback')
                transitions.append((item_id,reason))
            producer.on_tombstone=transitioned
            snapshot={'protocol':1,'revision':1,'services':[{'id':'a'}],'items':[],'tombstones':tombs}
            with patch.object(producer.state,'save',wraps=producer.state.save) as save:
                producer.accept(snapshot)
                self.assertEqual(save.call_count,4,'one watchdog save and three new tombstones')
                self.assertEqual(len(transitions),3)
                producer.accept(snapshot)
                self.assertEqual(save.call_count,5,'identical snapshot still persists watchdog once')
                self.assertEqual(len(transitions),3)
                snapshot['revision']=2
                producer.accept(snapshot)
                self.assertEqual(save.call_count,6,'new revision must not replay historical tombstones')
                self.assertEqual(len(transitions),3)
                tombs[0]['reason']='ended'; snapshot['revision']=3
                producer.accept(snapshot)
                self.assertEqual(save.call_count,8,'changed reason persists one new transition')
                self.assertEqual(len(transitions),4)
            recovered=cloud.Producer(directory,config,object(),clock=lambda:101)
            recovered.on_tombstone=transitioned
            with patch.object(recovered.state,'save',wraps=recovered.state.save) as save:
                recovered.accept(snapshot)
                self.assertEqual(save.call_count,1)
                self.assertEqual(len(transitions),4,'durable terminal receipts survive restart')

    def test_replayed_clear_cannot_dismiss_a_new_task_turn(self):
        from busybar_agents.view import ViewMode
        with tempfile.TemporaryDirectory() as directory:
            producer=cloud.Producer(directory,{'role':'agent','serviceId':'a','instanceId':'mac','epoch':'e'},object(),clock=lambda:100)
            record=producer.state.recognize('overlay',kind='agent',level='info',title='A',detail='',scene={})
            view=ViewMode(Path(directory)/'view.json'); cleared=set()
            def tombstone(item_id,reason):
                if reason=='cleared': cleared.add(item_id)
            producer.on_tombstone=tombstone
            key=json.dumps(['a','mac',record['itemId']],separators=(',',':'))
            snapshot={'protocol':1,'revision':1,'services':[{'id':'a'}],'items':[],
                      'tombstones':[{'itemKey':key,'version':record['version'],'reason':'cleared'}]}
            producer.accept(snapshot)
            if cleared:
                view.dismiss({('session','old')}); cleared.clear()
            self.assertFalse(view.allows({('session','old')}))
            self.assertTrue(view.allows({('session','new')}))
            snapshot['revision']=2; producer.accept(snapshot)
            if cleared:
                view.dismiss({('session','old'),('session','new')}); cleared.clear()
            self.assertTrue(view.allows({('session','new')}),'an old clear receipt must not hide a later turn')

    def test_failed_tombstone_save_can_retry_before_invoking_callback(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=cloud.Producer(directory,{'role':'agent','serviceId':'a','instanceId':'mac','epoch':'e'},object(),clock=lambda:100)
            record=producer.state.recognize('overlay',kind='agent',level='info',title='A',detail='B',scene={})
            callbacks=[]; producer.on_tombstone=lambda *args:callbacks.append(args)
            key=json.dumps(['a','mac',record['itemId']],separators=(',',':'))
            snapshot={'protocol':1,'revision':1,'services':[{'id':'a'}],'items':[],
                      'tombstones':[{'itemKey':key,'version':record['version'],'reason':'cleared'}]}
            save=producer.state.save; calls=[]
            def fail_terminal_save():
                calls.append(None)
                if len(calls)==2: raise OSError('disk unavailable')
                save()
            with patch.object(producer.state,'save',side_effect=fail_terminal_save):
                with self.assertRaises(OSError): producer.accept(snapshot)
            self.assertEqual(callbacks,[])
            self.assertNotIn('tombstone',cloud.State(producer.state.path).records['overlay'])
            producer.accept(snapshot)
            self.assertEqual(callbacks,[(record['itemId'],'cleared')])
            saved=cloud.State(producer.state.path).records['overlay']
            self.assertEqual(saved['tombstone'],'cleared')
            self.assertNotIn('scene',saved)

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

    def test_receipt_history_indexes_scoped_keys_once_per_record(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=cloud.Producer(directory,{'role':'notifier','serviceId':'n','instanceId':'m','epoch':'e'},
                                    object(),clock=lambda:100,notify=lambda *args:None)
            count=1000
            producer.state.records.update({str(n):{'itemId':str(n),'version':2,'acked':2,'level':'info',
                'kind':'event','firstRecognizedAt':1,'lastSourceAt':1,'tombstone':'expired',
                'fallbackPending':False} for n in range(count)})
            receipts=[{'itemKey':json.dumps(['n','m',str(n)],separators=(',',':')),'reason':'expired'}
                      for n in range(count)]
            # A receipt from another instance/service must never resolve ours.
            producer.state.records['live']={'itemId':'live','version':1,'acked':0,'level':'info',
                'kind':'event','firstRecognizedAt':1,'lastSourceAt':1}
            receipts.extend({'itemKey':json.dumps(parts,separators=(',',':')),'reason':'expired'}
                            for parts in (['other','m','live'],['n','other','live']))
            receipts.extend({'itemKey':key,'reason':'expired'} for key in ([],{},None,3))
            callbacks=[];producer.on_tombstone=lambda *args:callbacks.append(args)
            with patch('busybar_shared.cloud.json.dumps',wraps=json.dumps) as dumps:
                producer.accept({'protocol':1,'revision':1,'services':[{'id':'n'}],
                                 'items':[],'tombstones':receipts})
            self.assertLess(dumps.call_count,count*3,'history must not serialize every record per receipt')
            self.assertNotIn('tombstone',producer.state.records['live'])
            self.assertEqual(callbacks,[],'repeated receipts must retain existing no-op semantics')

    def test_receipt_history_does_not_scan_all_records_again_for_each_receipt(self):
        class CountedRecords(dict):
            visited=0
            def values(self):
                for value in super().values():
                    self.visited+=1
                    yield value
        with tempfile.TemporaryDirectory() as directory:
            producer=cloud.Producer(directory,{'role':'notifier','serviceId':'n','instanceId':'m','epoch':'e'},object(),clock=lambda:100,notify=lambda *args:None)
            count=1000
            records=CountedRecords({str(n):{'itemId':str(n),'version':2,'acked':2,'level':'info','kind':'event','firstRecognizedAt':1,'lastSourceAt':1,'tombstone':'expired','fallbackPending':False}for n in range(count)})
            records['duplicate-zero']={**records['0'],'acked':0}
            producer.state.records=producer.state.data['records']=records
            receipts=[{'itemKey':json.dumps(['n','m',str(n)],separators=(',',':')),'reason':'expired'}for n in range(count)]
            callbacks=[];producer.on_tombstone=lambda *args:callbacks.append(args)
            producer.accept({'protocol':1,'revision':1,'services':[{'id':'n'}],'items':[],'tombstones':receipts})
            self.assertLessEqual(records.visited,count*2,'one receipt index must not trigger a full history scan per receipt')
            self.assertEqual(records['duplicate-zero']['acked'],2)
            self.assertEqual(callbacks,[('0','expired')])

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
                # stop() intentionally uses bounded joins in production. The
                # fixture owns this directory and must await every writer before
                # TemporaryDirectory removes it, including a delayed watchdog.
                for thread in producer._threads:
                    thread.join(timeout=3)
                    self.assertFalse(thread.is_alive(), 'fixture worker did not stop')

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

class IdleHeartbeatTest(unittest.TestCase):
    def test_idle_publisher_reports_liveness_without_renewing_any_occurrence(self):
        with tempfile.TemporaryDirectory() as directory:
            clock=[100];calls=[]
            class HTTP:
                def request(self,method,path,body=None):
                    calls.append((path,body));return {'ok':True}
            producer=cloud.Producer(Path(directory),{'role':'notifier','serviceId':'notifier','instanceId':'mac','epoch':'e'},HTTP(),clock=lambda:clock[0],notify=lambda *args:None)
            producer.flush()
            beats=[body for path,body in calls if path=='/api/heartbeat']
            self.assertEqual(len(beats),1)
            self.assertEqual(beats[0]['itemIds'],[])
            producer.flush();self.assertEqual(len(calls),1)
            clock[0]+=5;producer.flush();self.assertEqual(len(calls),2)
            self.assertTrue(all(body['itemIds']==[] for _,body in calls))
            self.assertFalse(producer.state.records)
