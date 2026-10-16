import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from busybar_shared.cloud import Transport, Producer
from busybar_shared.preview import PreviewBridge

class ComputerSenderTest(unittest.TestCase):
    def test_transport_scopes_every_request_and_preview_to_explicit_service(self):
        requests=[]
        class Response:
            headers={}
            def read(self,_): return b'{}'
            def __enter__(self): return self
            def __exit__(self,*_): pass
        class Opener:
            def open(self,request,**_): requests.append(request);return Response()
        credential='a'*64+'.c.computer.'+'s'*43
        for service in ('github','datadog'):
            client=Transport('https://control.test',credential,service_id=service,opener=Opener())
            client.request('POST','/api/publish',{'app':'local-choice'})
            self.assertEqual(requests[-1].get_header('X-busy-service'),service)
            address,headers,device=client._preview_connection({'computerId':'computer','serviceId':service,'instanceId':'mac','epoch':'e'})
            self.assertEqual(headers['X-Busy-Service'],service)
            self.assertEqual(device,'a'*64)
        self.assertEqual([r.get_header('Authorization') for r in requests],['Bearer '+credential]*2)

    def test_per_service_outboxes_are_independent_under_one_computer(self):
        with tempfile.TemporaryDirectory() as folder:
            clients=[Producer(folder,{'role':'service-'+service,'serviceId':service,'instanceId':'mac','epoch':'e'},object(),clock=lambda:100) for service in ('github','datadog')]
            a=clients[0].state.recognize('item',kind='event',level='info',title='A',detail='',scene={})
            b=clients[1].state.recognize('item',kind='event',level='info',title='B',detail='',scene={})
            clients[0].state.tombstone(a['itemId'],'manual')
            self.assertFalse(clients[1].state.records['item'].get('tombstone'))
            self.assertNotEqual(a['itemId'],b['itemId'])

    def test_preview_considers_all_registered_services_with_agent_first(self):
        class Client:
            def __init__(self,template):self.config={'template':template}
        agent,github,plane=Client('agent'),Client('notifier'),Client('notifier')
        bridge=PreviewBridge(Path('/tmp'),{'github':github,'codex':agent,'adsbao':plane},status_path=False)
        self.assertEqual(bridge.clients[0],agent)
        self.assertEqual(set(bridge.clients),{agent,github,plane})
