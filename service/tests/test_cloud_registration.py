from pathlib import Path
import tempfile
import unittest
from busybar_service import cloud_registration as registration
from busybar_shared.cloud import CloudError

DEVICE='a'*64
COMPUTER='computer-a'
TICKET='enroll.'+DEVICE+'.'+COMPUTER+'.'+'t'*43
SECRET='s'*43
CREDENTIAL=DEVICE+'.c.'+COMPUTER+'.'+SECRET

class Store:
    def __init__(self,events):self.value=None;self.events=events
    def __call__(self,key,value=None):
        if value is not None:self.events.append('store');self.value=value
        elif self.value is None:raise CloudError('keychain_unavailable')
        return self.value

class RegistrationTest(unittest.TestCase):
    def test_saves_computer_credential_before_enrollment_request_without_secret_in_metadata(self):
        events=[]; store=Store(events)
        class HTTP:
            def __init__(self,url,secret):self.secret=secret
            def request(self,method,path,body=None):
                events.append(path)
                if path=='/api/computers/enroll':
                    self_check.assertEqual(store.value,CREDENTIAL)
                    self_check.assertEqual(body['managementSecret'],SECRET)
                    return {'computerId':COMPUTER,'enrolled':True}
                return {'deviceId':DEVICE,'computerId':COMPUTER,'configRevision':0,'services':[]}
        self_check=self
        with tempfile.TemporaryDirectory() as folder:
            value=registration.enroll(folder,'https://control.test',TICKET,store=store,transport=HTTP,secret_factory=lambda:SECRET)
            self.assertEqual(value['computerId'],COMPUTER)
            self.assertLess(events.index('store'),events.index('/api/computers/enroll'))
            text=(Path(folder)/'cloud-computer.json').read_text()
            self.assertNotIn(SECRET,text);self.assertNotIn(TICKET,text)
            self.assertEqual(registration.load_computer(folder)['phase'],'active')

    def test_lost_enrollment_response_resumes_with_the_pre_saved_key(self):
        events=[];store=Store(events);server={'enrolled':False}
        class HTTP:
            def __init__(self,url,secret):self.secret=secret
            def request(self,method,path,body=None):
                if path=='/api/computer':
                    if not server['enrolled']:raise CloudError('unauthorized',401)
                    return {'deviceId':DEVICE,'computerId':COMPUTER,'configRevision':0,'services':[]}
                server['enrolled']=True;raise CloudError('unavailable')
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(CloudError):registration.enroll(folder,'https://control.test',TICKET,store=store,transport=HTTP,secret_factory=lambda:SECRET)
            self.assertEqual(store.value,CREDENTIAL)
            registration.enroll(folder,'https://control.test',TICKET,store=store,transport=HTTP,secret_factory=lambda:self.fail('must reuse saved credential'))
            self.assertEqual(registration.load_computer(folder)['phase'],'active')
            self.assertEqual(events.count('store'),1)

    def test_keychain_failure_prevents_server_enrollment(self):
        class HTTP:
            def __init__(self,*_):raise AssertionError('must save first')
        def denied(*_):raise CloudError('keychain_unavailable')
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(CloudError,'keychain_unavailable'):
                registration.enroll(folder,'https://control.test',TICKET,store=denied,transport=HTTP,secret_factory=lambda:SECRET)

    def test_metadata_refuses_foreign_route_or_path_ids(self):
        import json
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'cloud-computer.json'
            data={'url':'https://control.test','deviceId':DEVICE,'computerId':COMPUTER,'instanceId':'mac','phase':'active','services':{},'routes':{'github':'foreign'}}
            path.write_text(json.dumps(data))
            with self.assertRaises(CloudError):registration.load_computer(folder)
            data['routes']={};data['services']={'bad':{'serviceId':'../escape','epoch':'e','template':'notifier'}};path.write_text(json.dumps(data))
            with self.assertRaises(CloudError):registration.load_computer(folder)

    def test_registers_two_service_ids_and_keeps_routes_local_to_the_computer(self):
        from busybar_shared.cloud import atomic_json
        events=[];store=Store(events);store.value=CREDENTIAL;remote=[]
        class HTTP:
            def __init__(self,url,secret):self_check.assertEqual(secret,CREDENTIAL)
            def request(self,method,path,body=None):
                if path=='/api/services':
                    self_check.assertNotIn('app',body)
                    remote.append({'id':body['id'],'name':body['name'],'template':body['template'],'computerId':COMPUTER,'epoch':'epoch-'+body['id']})
                    return {}
                return {'deviceId':DEVICE,'computerId':COMPUTER,'configRevision':len(remote),'services':remote}
        self_check=self
        with tempfile.TemporaryDirectory() as folder:
            atomic_json(Path(folder)/registration.FILE,{'url':'https://control.test','deviceId':DEVICE,'computerId':COMPUTER,'instanceId':'mac','phase':'active','services':{},'routes':{}})
            registration.register_service(folder,'github',store=store,transport=HTTP,id_factory=lambda:'github-service')
            registration.register_service(folder,'datadog',store=store,transport=HTTP,id_factory=lambda:'datadog-service')
            config=registration.load_computer(folder)
            self.assertEqual(config['routes'],{'github':'github-service','datadog':'datadog-service'})
            self.assertEqual({s['serviceId'] for s in config['services'].values()},{'github-service','datadog-service'})
            self.assertEqual(len(remote),2)
            registration.register_service(folder,'github',store=store,transport=HTTP,id_factory=lambda:self.fail('must reuse registered service'))
            self.assertEqual(len(remote),2)

    def test_resumes_registration_after_a_lost_post_response_without_creating_duplicate_ids(self):
        from busybar_shared.cloud import atomic_json
        events=[];store=Store(events);store.value=CREDENTIAL;remote=[]
        class HTTP:
            def __init__(self,*_):pass
            def request(self,method,path,body=None):
                if path=='/api/services':
                    remote.append({'id':body['id'],'name':body['name'],'template':body['template'],'computerId':COMPUTER,'epoch':'epoch'})
                    raise CloudError('unavailable')
                return {'deviceId':DEVICE,'computerId':COMPUTER,'configRevision':len(remote),'services':remote}
        with tempfile.TemporaryDirectory() as folder:
            atomic_json(Path(folder)/registration.FILE,{'url':'https://control.test','deviceId':DEVICE,'computerId':COMPUTER,'instanceId':'mac','phase':'active','services':{},'routes':{}})
            registration.register_service(folder,'github',store=store,transport=HTTP,id_factory=lambda:'one-id')
            self.assertEqual(registration.load_computer(folder)['services']['github']['serviceId'],'one-id')
            self.assertEqual(len(remote),1)

    def test_legacy_migration_proves_both_roles_and_saves_key_before_claim(self):
        from busybar_shared.cloud import atomic_json
        events=[]; values={'agent':DEVICE+'.agent.'+'a'*43,'notifier':DEVICE+'.notifier.'+'n'*43}
        def store(key,value=None):
            if value is not None:events.append('store');values[key]=value
            return values[key]
        class HTTP:
            def __init__(self,url,secret):self.secret=secret
            def request(self,method,path,body=None):
                events.append(path)
                if path=='/api/snapshot':
                    role=self.secret.split('.')[1]
                    return {'protocol':1,'deviceId':DEVICE,'services':[{'id':role,'computerId':COMPUTER,'template':role,'epoch':'old'}]}
                if path=='/api/computers/claim':
                    self_check.assertEqual(values['computer'],CREDENTIAL)
                    self_check.assertEqual(set(body['proofs']),{'agent','notifier'})
                    self_check.assertEqual(body['managementSecret'],SECRET)
                    return {'computerId':COMPUTER,'enrolled':True}
                return {'deviceId':DEVICE,'computerId':COMPUTER,'configRevision':0,'services':[]}
        self_check=self
        with tempfile.TemporaryDirectory() as folder:
            for role in ('agent','notifier'):
                atomic_json(Path(folder)/('cloud-'+role+'.json'),{'role':role,'url':'https://old.test','serviceId':role,'instanceId':'existing-mac','epoch':'old'})
            result=registration.migrate_legacy(folder,'https://control.test',store=store,transport=HTTP,secret_factory=lambda:SECRET)
            self.assertEqual(result['instanceId'],'existing-mac')
            self.assertEqual(result['phase'],'active')
            self.assertLess(events.index('store'),events.index('/api/computers/claim'))
            self.assertNotIn(SECRET,(Path(folder)/registration.FILE).read_text())

    def test_concurrent_registration_is_rejected_before_reading_credentials(self):
        import fcntl
        with tempfile.TemporaryDirectory() as folder:
            with (Path(folder)/'cloud-registration.lock').open('w') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with self.assertRaisesRegex(CloudError,'registration_busy'):
                    registration.register_service(folder,'github',store=lambda *_:self.fail('must lock first'))

    def test_pending_enrollment_resubmits_after_a_precommit_network_failure_and_real_404(self):
        events=[];store=Store(events);server={'tries':0,'enrolled':False}
        class HTTP:
            def __init__(self,*_):pass
            def request(self,method,path,body=None):
                if path=='/api/computer':
                    if not server['enrolled']:raise CloudError('http_404',404)
                    return {'deviceId':DEVICE,'computerId':COMPUTER,'configRevision':0,'services':[]}
                server['tries']+=1
                if server['tries']==1:raise CloudError('unavailable')
                server['enrolled']=True;return {'computerId':COMPUTER,'enrolled':True}
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(CloudError):registration.enroll(folder,'https://control.test',TICKET,store=store,transport=HTTP,secret_factory=lambda:SECRET)
            result=registration.enroll(folder,'https://control.test',TICKET,store=store,transport=HTTP,secret_factory=lambda:self.fail('must not rotate'))
            self.assertEqual(result['phase'],'active');self.assertEqual(events.count('store'),1)

    def test_route_accepts_any_owned_service_id_and_rejects_peer_without_writes(self):
        from busybar_shared.cloud import atomic_json
        events=[];store=Store(events);store.value=CREDENTIAL
        class HTTP:
            def __init__(self,*_):pass
            def request(self,*_):
                return {'deviceId':DEVICE,'computerId':COMPUTER,'services':[
                    {'id':'arbitrary-id','name':'Anything','template':'notifier','epoch':'epoch','computerId':COMPUTER},
                    {'id':'peer-id','name':'Peer','template':'notifier','epoch':'e','computerId':'peer'}]}
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/registration.FILE
            atomic_json(path,{'url':'https://control.test','deviceId':DEVICE,'computerId':COMPUTER,'instanceId':'mac','phase':'active','services':{},'routes':{}})
            value=registration.route_service(folder,'my-source','arbitrary-id',store=store,transport=HTTP)
            self.assertEqual(value['routes']['my-source'],'arbitrary-id')
            value['services']['arbitrary-id'].update(pending=True,epoch='old')
            atomic_json(path,value)
            value=registration.route_service(folder,'second-source','arbitrary-id',store=store,transport=HTTP)
            self.assertFalse(value['services']['arbitrary-id']['pending']);self.assertEqual(value['services']['arbitrary-id']['epoch'],'epoch')
            rotated=dict(value);rotated['services']['arbitrary-id']['epoch']='stale';atomic_json(path,rotated)
            with self.assertRaisesRegex(CloudError,'registration_epoch_changed'):
                registration.route_service(folder,'new-source','arbitrary-id',store=store,transport=HTTP)
            value['services']['arbitrary-id']['epoch']='epoch';atomic_json(path,value)

            before=path.read_bytes()
            with self.assertRaisesRegex(CloudError,'service_not_owned'):
                registration.route_service(folder,'my-source','peer-id',store=store,transport=HTTP)
            self.assertEqual(path.read_bytes(),before)

    def test_handover_keeps_receipts_and_deadlines_but_removes_old_namespace_proofs(self):
        import json
        from busybar_shared.cloud import atomic_json
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            atomic_json(root/registration.FILE,{'url':'https://control.test','deviceId':DEVICE,'computerId':COMPUTER,'instanceId':'mac','phase':'active','services':{
                'adsbao':{'serviceId':'new','name':'ADSBao','template':'notifier','epoch':'new-epoch','pending':False}},'routes':{'adsbao':'new'}})
            atomic_json(root/'cloud-notifier.json',{'role':'notifier','url':'https://old.test','serviceId':'old','instanceId':'mac','epoch':'old-epoch'})
            import time
            before_ms=int(time.time()*1000)
            old={'epoch':'old-epoch','actions':{},'assets':{},'inputs':{},'ends':{},'records':{
                'adsbao:waiting':{'itemId':'waiting','kind':'event','level':'info','title':'Waiting','detail':'','firstRecognizedAt':123,'lastSourceAt':123,'version':2,'acked':2,'deadline':123,'scene':{'commands':[]},'publishBody':{'epoch':'old'},'proofUntil':999},
                'adsbao:shown':{'itemId':'shown','kind':'event','version':1,'acked':1,'admitted':True,'deadline':101},
                'adsbao:ended':{'itemId':'ended','kind':'event','version':1,'tombstone':'completed','deadline':100},
                'adsbao:urgent':{'itemId':'urgent','kind':'condition','level':'urgent','version':1,'acked':1,'deadline':before_ms+70000,'proofUntil':before_ms+60000,'suppressed':True},
                'other:record':{'itemId':'other','version':1}}}
            atomic_json(root/'cloud-notifier-state.json',old)
            before=(root/'cloud-notifier-state.json').read_bytes()
            self.assertEqual(registration.migrate_outboxes(root),1)
            path=root/'cloud-service-new-state.json';data=json.loads(path.read_text());rec=data['records']['adsbao:waiting']
            self.assertEqual(rec['deadline'],123);self.assertEqual(rec['itemId'],'waiting');self.assertEqual(rec['acked'],0)
            self.assertFalse(rec['renderPending']);self.assertTrue(rec['handoverPendingSource']);self.assertNotIn('publishBody',rec);self.assertNotIn('proofUntil',rec)
            urgent=data['records']['adsbao:urgent']
            self.assertLessEqual(urgent['deadline'],int(time.time()*1000)+10000);self.assertGreaterEqual(urgent['deadline'],before_ms)
            self.assertFalse(urgent['suppressed'])
            self.assertEqual(data['epoch'],'new-epoch');self.assertEqual(data['records']['adsbao:shown']['tombstone'],'migrated')
            self.assertEqual(data['records']['adsbao:ended']['tombstone'],'completed');self.assertNotIn('other:record',data['records'])
            from busybar_shared.cloud import Producer
            from busybar_service.cloud_adapter import CloudQueue
            class HTTP:
                def __init__(self):self.published=[]
                def request(self,method,path,body=None):
                    if path=='/api/publish':self.published.append(body)
                    return {}
            http=HTTP();producer=Producer(root,{'role':'service-new','serviceId':'new','instanceId':'mac','epoch':'new-epoch'},http)
            producer.flush();self.assertEqual(http.published,[])
            # source_ok is what an empty successful cursor-based event poll calls.
            CloudQueue(producer).source_ok('adsbao',10)
            producer.flush();self.assertEqual([body['itemId'] for body in http.published],['waiting'])
            self.assertEqual((root/'cloud-notifier-state.json').read_bytes(),before)
            self.assertEqual(registration.migrate_outboxes(root),0)
            old['actions']={'a':{'status':'unknown'}};atomic_json(root/'cloud-notifier-state.json',old)
            with self.assertRaisesRegex(CloudError,'local_action_unresolved'):registration.migrate_outboxes(root)

    def test_game_registration_sends_requested_group_without_changing_other_services(self):
        from busybar_shared.cloud import atomic_json
        store=Store([]);store.value=CREDENTIAL;remote=[];requests=[]
        class HTTP:
            def __init__(self,*_):pass
            def request(self,method,path,body=None):
                if path=='/api/services':
                    requests.append(body)
                    remote.append({**body,'epoch':'e'})
                    return {}
                return {'deviceId':DEVICE,'computerId':COMPUTER,'configRevision':len(remote),'services':remote}
        with tempfile.TemporaryDirectory() as folder:
            atomic_json(Path(folder)/registration.FILE,{'url':'https://control.test','deviceId':DEVICE,
                'computerId':COMPUTER,'instanceId':'mac','phase':'active','services':{},'routes':{}})
            registration.register_service(folder,'wow',template='custom',priority_group='dispensable',
                store=store,transport=HTTP,id_factory=lambda:'wow-id')
            self.assertEqual(requests[0]['priorityGroup'],'dispensable')
            registration.register_service(folder,'wow',template='custom',priority_group='dispensable',store=store,transport=HTTP)
            self.assertEqual(len(requests),1)
            with self.assertRaisesRegex(CloudError,'invalid_service'):
                registration.register_service(folder,'bad',priority_group='invalid',store=store,transport=HTTP)
