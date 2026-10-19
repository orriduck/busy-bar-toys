import json
from pathlib import Path
import tempfile
import unittest
from busybar_shared.cloud import Producer
from busybar_apps import load_agents
from busybar_notifier.model import Notification
from busybar_service.cloud_adapter import CloudQueue, notification_scene, AgentRenderer
from busybar_agents.events import Task

load_agents()

class FakeHTTP:
    def __init__(self): self.calls=[]
    def request(self,method,path,body=None):
        self.calls.append((method,path,body))
        return {'hash':body['hash']} if path=='/api/assets' else {'ok':True}

class AdapterTest(unittest.TestCase):
    def producer(self,directory,role='notifier'):
        return Producer(Path(directory),{'role':role,'serviceId':role,'instanceId':'mac','epoch':'e'},FakeHTTP(),clock=lambda:100,notify=lambda *args:None)

    def test_all_group_members_publish_and_errors_do_not_resolve_urgent(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory); queue=CloudQueue(producer,reduced=True)
            a=Notification('a','urgent','app','APP','A',group='g',source='source')
            b=Notification('b','attention','app','APP','B',group='g',source='source')
            queue.set_state('source',[a,b]); producer.flush()
            published=[body for _,path,body in producer.http.calls if path=='/api/publish']
            self.assertEqual(len(published),2)
            self.assertTrue(all(p['kind']=='condition' and p['groupKey']=='g' for p in published))
            queue.source_error('source',RuntimeError('broken'))
            self.assertFalse(any(r.get('cleared') for r in producer.state.records.values()))
            self.assertTrue(all(r.get('sourceUnknown') for r in producer.state.records.values()))
            queue.set_state('source',[])
            self.assertTrue(all(r.get('cleared') for r in producer.state.records.values()))

    def test_successful_event_poll_keeps_waiting_events_live_and_error_stops_renewal(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory); queue=CloudQueue(producer,reduced=True)
            queue.push([Notification('x','urgent','app','APP','X',source='slow')])
            queue.source_ok('slow',120)
            record=next(iter(producer.state.records.values()))
            self.assertGreaterEqual(record['sourceFreshUntil'],250000)
            queue.source_error('slow',RuntimeError())
            self.assertTrue(record['sourceUnknown'])

    def test_poller_error_hook_retains_confirmed_urgent_condition(self):
        from busybar_notifier.source import Poller, Source
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory); queue=CloudQueue(producer,reduced=True)
            values=[[Notification('x','urgent','app','APP','Page')]]
            def poll(now):
                if values: return values.pop()
                raise RuntimeError('source unavailable')
            source=Source('pages','app',30,'state',poll)
            poller=Poller([source],queue,wall=lambda:100,spawn=lambda work:work())
            poller._run(source)
            record=producer.state.records['pages:x']
            self.assertFalse(record.get('sourceUnknown'))
            with self.assertLogs('busy-bar',level='WARNING'): poller._run(source)
            self.assertTrue(record['sourceUnknown'])
            self.assertFalse(record.get('cleared'))

    def test_urgent_render_failure_keeps_deadline_and_later_recovers_same_identity(self):
        from unittest.mock import patch
        from busybar_shared.cloud import CloudError
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory); queue=CloudQueue(producer,reduced=True); notices=[]
            producer.guard.notify=lambda *args:notices.append(args)
            item=Notification('x','urgent','app','APP','Urgent','Detail',source='source')
            with patch('busybar_service.cloud_adapter.notification_scene',side_effect=CloudError('local_asset_capacity')):
                with self.assertRaises(CloudError): queue.set_state('source',[item])
            record=producer.state.records['source:x']; ident=record['itemId']; deadline=record['deadline']
            self.assertTrue(record['renderPending'])
            producer.flush()
            self.assertFalse(any(path=='/api/publish' for _,path,_ in producer.http.calls))
            producer.guard.clock=lambda:111; producer.guard.monotonic=lambda:111
            producer.guard.check(); self.assertEqual(notices,[('Urgent','Detail')])
            queue.set_state('source',[item])
            self.assertEqual(producer.state.records['source:x']['itemId'],ident)
            self.assertEqual(producer.state.records['source:x']['deadline'],deadline)
            self.assertFalse(producer.state.records['source:x']['renderPending'])
            producer.flush()
            self.assertTrue(any(path=='/api/publish' for _,path,_ in producer.http.calls))

    def test_notification_recovery_has_shared_coin_and_final_transparent_renewal_target(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory)
            item=Notification('a','urgent','app','BRAND','This long title rolls','Detail')
            scene=notification_scene(producer,item)
            offsets=[c['offsetMs'] for c in scene['commands']]
            self.assertEqual(offsets[0],0)
            self.assertEqual(scene['entryDurationMs'],720)
            self.assertEqual(offsets[-1],scene['entryDurationMs'])
            self.assertIn('notice-detail',{e['id'] for e in scene['commands'][0]['elements']})
            entry=next(e for e in scene['commands'][0]['elements'] if e['id']=='shared-service-entry')
            final=scene['commands'][-1]['elements'][0]
            self.assertEqual(final['id'],entry['id'])
            self.assertNotEqual(final['assetHash'],entry['assetHash'])
            encoded=json.dumps(scene)
            self.assertNotIn('"path"',encoded); self.assertNotIn('"timeout"',encoded)
            self.assertIn('assetHash',encoded)
            self.assertTrue(all(a['type']=='anim' for a in producer.state.data['assets'].values()))

    def test_agent_rate_update_does_not_replay_shared_entry(self):
        from dataclasses import replace
        from busybar_agents.tokens import TokenUsage
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory,'agent'); renderer=AgentRenderer(producer)
            task=Task('s','t','codex','project','working',90,100,token_rate=TokenUsage(1001,1001))
            renderer.show(task,100)
            record=producer.state.records['agent']; first=record['itemId']
            self.assertEqual(record['scene']['entryDurationMs'],720)
            self.assertTrue(any(e['id']=='shared-service-entry' for e in record['scene']['commands'][0]['elements']))
            producer.flush()
            key=json.dumps(['agent','mac',first],separators=(',',':'))
            producer.snapshot={'selected':key,'generation':1,'items':[{'itemId':first,'itemKey':key,'app':'codex'}]}
            renderer.show(replace(task,token_rate=TokenUsage(1999,1999)),100)
            producer.flush()
            updates=[body for _,path,body in producer.http.calls if path=='/api/update']
            self.assertTrue(updates)
            self.assertFalse(any(e['id']=='shared-service-entry' for e in updates[-1]['elements']))
            self.assertEqual(record['itemId'],first)

    def test_agent_content_updates_preserve_complete_recovery_scene(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory,'agent'); renderer=AgentRenderer(producer,reduced=True)
            task=Task('s','t','codex','project','working',90,100)
            renderer.show(task,100,1,None)
            record=producer.state.records['agent']
            self.assertTrue(all(len(json.dumps(e))<=8192 for c in record['scene']['commands'] for e in c['elements']))
            first=record['itemId']; initial=record['version']
            producer.flush()
            key=json.dumps(['agent','mac',first],separators=(',',':'))
            producer.snapshot={'selected':key,'generation':1,'items':[{'itemId':first,'itemKey':key,'app':'codex'}]}
            renderer.show(task,160,1,None); producer.flush()
            self.assertEqual(record['itemId'],first)
            self.assertGreater(record['version'],initial)
            update=[b for _,p,b in producer.http.calls if p=='/api/update']
            self.assertTrue(update)
            self.assertEqual(update[-1]['scene'],record['scene'])
            self.assertGreaterEqual(len(record['scene']['commands'][0]['elements']),3)

    def test_agent_shows_the_reported_reply_throughput(self):
        from busybar_agents.tokens import TokenUsage
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory,'agent'); renderer=AgentRenderer(producer,reduced=True)
            task=Task('s','t','codex','project','working',90,100,TokenUsage(1000,400))
            renderer.show(task,100)
            record=producer.state.records['agent']; version=record['version']
            self.assertIsNone(renderer.motion.current.usage,'Totals alone are not a rate')
            task.token_rate=TokenUsage(500,50)
            renderer.show(task,100)
            self.assertGreater(record['version'],version)
            self.assertEqual(renderer.motion.current.usage,TokenUsage(500,50))

    def test_unchanged_agent_scene_still_renews_local_source_liveness(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory,'agent'); renderer=AgentRenderer(producer,reduced=True)
            task=Task('s','t','codex','project','working',90,100)
            renderer.show(task,100)
            version=producer.state.records['agent']['version']
            producer.clock=lambda:140
            renderer.show(task,100)
            self.assertEqual(producer.state.records['agent']['version'],version)
            self.assertEqual(producer.state.records['agent']['lastSourceAt'],140000)

    def test_done_to_idle_does_not_create_a_second_standby_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory,'agent'); renderer=AgentRenderer(producer,reduced=True)
            renderer.show(Task('s','t','codex','project','done',90,100),100)
            ident=producer.state.records['agent']['itemId']
            renderer.show(None,120)
            self.assertEqual(producer.state.records['agent']['itemId'],ident)
            self.assertEqual(producer.state.records['agent']['kind'],'event')

    def test_new_turn_after_restart_replaces_a_cleared_old_turn(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory,'agent'); renderer=AgentRenderer(producer,reduced=True)
            renderer.show(Task('s','t','codex','project','working',90,100),100)
            ident=producer.state.records['agent']['itemId']; producer.state.tombstone(ident,'cleared')
            producer2=self.producer(directory,'agent'); renderer2=AgentRenderer(producer2,reduced=True)
            renderer2.show(Task('s','next','codex','project','working',100,110),110)
            self.assertNotEqual(producer2.state.records['agent']['itemId'],ident)

    def test_aircraft_rearm_has_new_occurrence_but_pending_replay_dedupes(self):
        from types import SimpleNamespace
        from busybar_apps.adsbao.proximity import EncounterTracker
        from busybar_apps.adsbao.traffic import parse_envelope
        from busybar_apps.adsbao.display import notification
        def frame(now,lon=.01):
            return parse_envelope({'channel':'nearby:0.00:0.00','sequence':1,'stale':False,'emittedAt':now,'fetchedAt':now,'data':{'aircraft':{'ac':[{'hex':'abc123','flight':'TEST123','lat':0,'lon':lon,'fixAt':now}]}}},now=now)
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory); queue=CloudQueue(producer,reduced=True)
            path=Path(directory)/'encounters.json'; fix=SimpleNamespace(latitude=0,longitude=0)
            tracker=EncounterTracker(path); first=tracker.candidate(frame(1000),fix,now=1000)
            queue.push([notification(first)])
            record=next(iter(producer.state.records.values())); item_id=record['itemId']
            producer.state.tombstone(item_id,'completed')
            tracker=EncounterTracker(path)
            queue.push([notification(tracker.candidate(frame(1001),fix,now=1001))])
            self.assertEqual(len(producer.state.records),1)
            tracker.mark_alerted(first,now=1001)
            tracker.candidate(frame(1031,.06),fix,now=1031); tracker.candidate(frame(1091,.06),fix,now=1091)
            queue.push([notification(tracker.candidate(frame(1092),fix,now=1092))])
            new=[r for r in producer.state.records.values() if not r.get('tombstone')]
            self.assertEqual(len(new),1)
            self.assertNotEqual(new[0]['itemId'],item_id)

    def test_recurrence_prunes_callback_and_notification_memory(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory); queue=CloudQueue(producer,reduced=True)
            item=Notification('x','urgent','app','APP','X',source='source',primary=lambda:None)
            for index in range(20):
                queue.set_state('source',[item]); queue.set_state('source',[])
            self.assertEqual(queue._items,{})
            self.assertEqual(producer.actions.callbacks,{})

    def test_backend_terminal_state_prunes_notification_and_callback_memory(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory); queue=CloudQueue(producer,reduced=True)
            queue.push([Notification('x','urgent','app','APP','X',source='source',primary=lambda:None)])
            record=next(iter(producer.state.records.values()))
            key=json.dumps(['notifier','mac',record['itemId']],separators=(',',':'))
            producer.accept({'protocol':1,'revision':1,'services':[],'items':[], 'tombstones':[{'itemKey':key,'version':1,'reason':'action-succeeded'}]})
            self.assertEqual(queue._items,{})
            self.assertEqual(producer.actions.callbacks,{})

    def test_admission_callback_only_after_device_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory); queue=CloudQueue(producer,reduced=True); shown=[]
            queue.on_shown=shown.append
            item=Notification('x','info','app','APP','Title',source='source')
            queue.push([item]); ident=next(iter(producer.state.records.values()))['itemId']
            key=json.dumps(['notifier','mac',ident],separators=(',',':'))
            snap={'protocol':1,'revision':1,'generation':1,'services':[], 'items':[{'itemId':ident,'itemKey':key,'instanceId':'mac','version':producer.state.records['source:x']['version']}], 'displaying':None}
            producer.accept(snap); self.assertEqual(shown,[])
            snap.update(revision=2,health={'status':'healthy'},displaying={'itemKey':key,'generation':1,'confirmedValidUntil':110000})
            snap['items'][0]['coverageProof']={'revision':2,'version':snap['items'][0]['version'],'itemKey':key,'controller':{'itemKey':key,'generation':1},'validUntil':110000}
            producer.accept(snap); self.assertEqual(shown,[item])

    def test_actual_source_app_survives_publish_and_changes_version(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory); queue=CloudQueue(producer,reduced=True)
            item=Notification('x','info','first-app','APP','Title',source='source')
            queue.push([item]); producer.flush()
            record=producer.state.records['source:x']; version=record['version']; ident=record['itemId']
            self.assertEqual([b for _,p,b in producer.http.calls if p=='/api/publish'][-1].get('app'),'first-app')
            from dataclasses import replace
            item=replace(item,app='next-app')
            queue.push([item]); producer.flush()
            self.assertEqual(record['itemId'],ident)
            self.assertGreater(record['version'],version)
            self.assertEqual([b for _,p,b in producer.http.calls if p=='/api/publish'][-1].get('app'),'next-app')

    def test_agent_actual_source_app_is_published(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory,'agent'); renderer=AgentRenderer(producer,reduced=True)
            renderer.show(Task('s','t','dots','project','working',90,100),100)
            producer.flush()
            self.assertEqual([b for _,p,b in producer.http.calls if p=='/api/publish'][-1].get('app'),'dots')

    def test_selected_legacy_agent_upgrades_app_with_full_publish_then_resumes_deltas(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory,'agent'); renderer=AgentRenderer(producer,reduced=True)
            task=Task('s','t','codex','project','working',90,100)
            renderer.show(task,100); producer.flush()
            record=producer.state.records['agent']; ident=record['itemId']
            key=json.dumps(['agent','mac',ident],separators=(',',':'))
            # Old durable and remote records can lack app. Keep occurrence and
            # remaining time, while forcing new metadata through /publish.
            producer.snapshot={'selected':key,'generation':1,'items':[{'itemId':ident,'itemKey':key}]}
            producer.http.calls.clear()
            renderer.show(task,160); producer.flush()
            self.assertEqual(record['itemId'],ident)
            published=[b for _,p,b in producer.http.calls if p=='/api/publish']
            self.assertEqual(len(published),1)
            self.assertEqual(published[0]['app'],'codex')
            producer.snapshot['items'][0]['app']='codex'
            producer.http.calls.clear()
            renderer.show(task,220); producer.flush()
            self.assertTrue(any(p=='/api/update' for _,p,_ in producer.http.calls))

    def test_agent_app_metadata_change_survives_identical_rendered_pixels(self):
        from dataclasses import replace
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory,'agent'); renderer=AgentRenderer(producer,reduced=True)
            task=Task('s','t','custom-one','project','working',90,100)
            renderer.show(task,100); producer.flush()
            record=producer.state.records['agent']; ident=record['itemId']; version=record['version']
            scene=record['scene']
            renderer.show(replace(task,source='custom-two'),100); producer.flush()
            self.assertEqual(record['itemId'],ident)
            self.assertGreater(record['version'],version)
            self.assertEqual(record['scene'],scene)
            self.assertEqual([b for _,p,b in producer.http.calls if p=='/api/publish'][-1]['app'],'custom-two')

class AgentNotificationRoutingTest(unittest.TestCase):
    producer = AdapterTest.producer
    def test_waiting_uses_separate_notifier_and_resolves_on_working(self):
        from busybar_service.cloud_adapter import AgentSignals
        with tempfile.TemporaryDirectory() as directory:
            status=self.producer(directory,'agent'); notices=self.producer(directory,'agent-notifier')
            renderer=AgentSignals(AgentRenderer(status,reduced=True),CloudQueue(notices,reduced=True))
            task=Task('session','turn','codex','project','working',100,100)
            renderer.show(task,100)
            self.assertFalse(status.state.records['agent'].get('cleared'))
            task.state='waiting';renderer.show(task,101)
            self.assertTrue(status.state.records['agent']['cleared'])
            record=next(iter(notices.state.records.values()))
            self.assertEqual((record['kind'],record['level'],record['exit']),('condition','attention','source'))
            self.assertIn('input',record['title'].lower())
            occurrence=record['itemId'];renderer.show(task,102)
            self.assertEqual(next(iter(notices.state.records.values()))['itemId'],occurrence)
            task.state='working';renderer.show(task,103)
            self.assertTrue(next(iter(notices.state.records.values()))['cleared'])
            self.assertFalse(status.state.records['agent'].get('cleared'))

    def test_withdrawal_is_durable_until_server_ack_and_does_not_republish(self):
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory);queue=CloudQueue(producer,reduced=True)
            queue.push([Notification('one','info','app','APP','ONE',source='test')]);producer.flush()
            queue.withdraw('test','one');producer.flush()
            requests=[b for _,p,b in producer.http.calls if p=='/api/withdraw']
            self.assertEqual(len(requests),1)
            self.assertEqual(requests[0]['itemId'],producer.state.records['test:one']['itemId'])
            self.assertFalse(producer.state.data['ends'])

    def test_two_waiting_sessions_remain_independent_while_other_task_runs(self):
        from busybar_service.cloud_adapter import AgentSignals
        with tempfile.TemporaryDirectory() as directory:
            status=self.producer(directory,'agent');notices=self.producer(directory,'agent-notifier')
            renderer=AgentSignals(AgentRenderer(status,reduced=True),CloudQueue(notices,reduced=True))
            a=Task('a','1','codex','A','waiting',100,100);b=Task('b','2','codex','B','waiting',100,101)
            work=Task('c','3','codex','C','working',100,101)
            renderer.show_tasks([a,b,work],101)
            ids={k:r['itemId'] for k,r in notices.state.records.items()}
            self.assertEqual(len(ids),2);self.assertFalse(status.state.records['agent'].get('cleared'))
            renderer.show_tasks([a,work],102)
            live={k:r['itemId'] for k,r in notices.state.records.items() if not r.get('cleared')}
            self.assertEqual(len(live),1);self.assertTrue(all(ids[k]==v for k,v in live.items()))

    def test_withdrawal_failure_remains_in_outbox_for_retry(self):
        from busybar_shared.cloud import CloudError
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            producer=self.producer(directory);queue=CloudQueue(producer,reduced=True)
            queue.push([Notification('one','info','app','APP','ONE',source='test')]);producer.flush()
            queue.withdraw('test','one')
            with patch.object(producer.http,'request',side_effect=CloudError('offline')):
                with self.assertRaises(CloudError):producer.flush()
            self.assertTrue(producer.state.data['ends'])
            producer.flush();self.assertFalse(producer.state.data['ends'])
            self.assertTrue(producer.state.records['test:one']['cleared'])
