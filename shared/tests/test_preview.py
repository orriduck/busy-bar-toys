import asyncio
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from websockets.exceptions import WebSocketException

from busybar_shared import preview
from busybar_shared.cloud import Producer, Transport

SERIAL='test-serial'
DEVICE=hashlib.sha256(SERIAL.encode()).hexdigest()
BGR=bytes((3,2,1))*1152
WIRE=base64.b64encode(BGR)

class PreviewValidationTest(unittest.TestCase):
    def test_only_explicit_private_literal_addresses(self):
        self.assertEqual(preview.private_address('192.168.4.2:8080'),('192.168.4.2',8080))
        self.assertEqual(preview.private_address('[fd00::1]:80'),('fd00::1',80))
        for addr in ('example.com','https://192.168.1.2','127.0.0.1','169.254.1.1','0.0.0.0',
                     '224.0.0.1','8.8.8.8','192.168.1.2/abc','u:p@192.168.1.2','192.168.1.2?x=1',
                     '192.168.1.2:0','192.168.1.2:','[fd00::1]trailing','[fd00::1%lo0]',
                     '192.168.1.2#frag','192.168.1.2\r\nX: value'):
            with self.subTest(addr=addr), self.assertRaises(preview.PreviewError):
                preview.private_address(addr)

    def test_demand_is_strictly_bound_to_credential_device(self):
        demand={'type':'demand','enabled':True,'targetFps':30,'streamId':'stream-1','deviceId':DEVICE}
        self.assertTrue(preview.parse_demand(json.dumps(demand),DEVICE)['enabled'])
        self.assertEqual(preview.parse_demand(json.dumps({**demand,'targetFps':2}),DEVICE)['targetFps'],2)
        with self.assertRaises(preview.PreviewError):preview.parse_demand(json.dumps({**demand,'targetFps':60}),DEVICE)
        for change in ({'deviceId':'b'*64},{'enabled':1},{'targetFps':True},{'streamId':''},{'extra':True}):
            with self.subTest(change=change),self.assertRaises(preview.PreviewError):
                preview.parse_demand(json.dumps({**demand,**change}),DEVICE)
        with self.assertRaises(preview.PreviewError):
            preview.parse_demand(json.dumps({**demand,'deviceId':'invalid'}),'invalid')
        for raw in ('[]','{"type":"frame"}',b'{}','x'*6144):
            with self.assertRaises(preview.PreviewError): preview.parse_demand(raw,DEVICE)

    def test_strict_native_bgr_frame_is_encoded_as_rgb(self):
        pixels=preview.rgb_pixels(WIRE)
        self.assertEqual(base64.b64decode(pixels),bytes((1,2,3))*1152)
        for raw in (b'!',WIRE+b'x',b' '+WIRE,WIRE+b'\r\n',base64.b64encode(b'short')):
            with self.assertRaises(preview.PreviewError): preview.rgb_pixels(raw)
        self.assertEqual(preview.rgb_pixels(b'"'+WIRE+b'"'),pixels)

    def test_config_validation_precedes_any_token_access(self):
        with tempfile.TemporaryDirectory() as runtime:
            path=Path(runtime)/'input.json'
            for value in ({'addr':'8.8.8.8'},{'addr':'192.168.1.2','unknown':1}, {'addr':False}):
                path.write_text(json.dumps(value))
                with patch.object(preview,'read_input_token') as secret:
                    with self.assertRaises(preview.PreviewError): preview.local_device(runtime)
                    secret.assert_not_called()

    def test_transport_exposes_only_private_preview_connection_material(self):
        transport=Transport('https://cloud.example',DEVICE+'.service.secret')
        url,headers,device=transport._preview_connection({'instanceId':'mac','epoch':'epoch'})
        self.assertEqual(url,'wss://cloud.example/api/preview/publish')
        self.assertEqual(device,DEVICE)
        self.assertEqual(headers['Authorization'],'Bearer '+DEVICE+'.service.secret')
        self.assertEqual(headers['X-Busy-Instance'],'mac')
        self.assertEqual(headers['X-Busy-Epoch'],'epoch')


class LocalHTTPTest(unittest.TestCase):
    def setUp(self):
        self.calls=[]; owner=self
        class Handler(BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def log_message(self,*args): pass
            def handle(self):
                try: super().handle()
                except (BrokenPipeError,ConnectionResetError): pass
            def do_GET(self):
                owner.calls.append((self.path,self.headers.get('X-API-Token'),self.client_address[1]))
                if getattr(owner,'slow_header',False):
                    for byte in b'HTTP/1.1 200 OK\r\nContent-Length: 4608\r\n\r\n':
                        self.connection.sendall(bytes((byte,))); time.sleep(.02)
                    self.connection.sendall(WIRE); return
                body=(json.dumps({'device':{'serial_number':SERIAL}}).encode() if self.path.startswith('/api/status') else WIRE)
                if getattr(owner,'padded_headers',False) and self.path.startswith('/api/status'):
                    body=body.ljust(665,b' ')
                status=getattr(owner,'response_status',200)
                self.send_response(status)
                if status==302: self.send_header('Location','http://127.0.0.1:1/private-secret')
                if getattr(owner,'close_response',False): self.send_header('Connection','close')
                length=str(len(body))
                if getattr(owner,'padded_headers',False): length=' \t'+length+'        \t'
                length=getattr(owner,'content_length_value',length)
                self.send_header('Content-Length',length); self.end_headers()
                if getattr(owner,'close_response',False): time.sleep(.03)
                self.wfile.write(body)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
        with patch.object(preview,'private_address',return_value=self.server.server_address):
            self.device=preview.LocalDevice('192.168.1.2','local-secret')

    def tearDown(self):
        self.device.close(); self.server.shutdown(); self.server.server_close(); self.thread.join()

    def test_real_http_identity_and_frame_share_persistent_slot_and_never_write(self):
        self.device.verify(DEVICE)
        self.assertEqual(base64.b64decode(self.device.frame(0)),bytes((1,2,3))*1152)
        self.assertEqual([x[0] for x in self.calls],['/api/status','/api/screen?display=0'])
        self.assertTrue(all(x[1]=='local-secret' for x in self.calls))
        self.assertEqual(self.calls[0][2],self.calls[1][2])
        with self.assertRaisesRegex(preview.PreviewError,'device_mismatch'): self.device.verify('0'*64)

    def test_native_padded_content_length_status_and_screen_are_valid(self):
        self.padded_headers=True
        self.device.verify(DEVICE)
        self.assertEqual(base64.b64decode(self.device.frame(0)),bytes((1,2,3))*1152)
        self.assertEqual([call[0] for call in self.calls],['/api/status','/api/screen?display=0'])

    def test_content_length_ows_does_not_relax_invalid_or_oversize_values(self):
        for value in ('',' \t','+4608','-1','46 08','4608\v','4611',' \t4611 \t'):
            with self.subTest(value=value):
                self.content_length_value=value
                with self.assertRaises(preview.PreviewError): self.device.frame(0)

    def test_http_connection_close_body_still_decodes_with_deadline(self):
        self.close_response=True
        self.assertEqual(base64.b64decode(self.device.frame(0)),bytes((1,2,3))*1152)

    def test_http_debug_configuration_cannot_print_local_credentials(self):
        import contextlib
        import io
        output=io.StringIO()
        with patch.object(preview.HTTPConnection,'debuglevel',1), contextlib.redirect_stdout(output):
            self.device.frame(0)
        self.assertNotIn('local-secret',output.getvalue())

    def test_whole_http_read_deadline_includes_slow_headers(self):
        self.slow_header=True
        started=time.monotonic()
        with self.assertRaises(preview.PreviewError): self.device.frame(0)
        self.assertLess(time.monotonic()-started,.55)

    def test_redirect_and_auth_failures_are_generic_and_never_followed(self):
        for code,expected in ((302,'redirect_refused'),(401,'auth'),(403,'auth')):
            self.response_status=code
            with self.assertRaises(preview.PreviewError) as failure: self.device.frame(0)
            self.assertEqual(failure.exception.code,expected)
            self.assertNotIn('secret',str(failure.exception))
        self.assertEqual(len(self.calls),3)


def client_for(url):
    from types import SimpleNamespace
    config={'role':'agent','serviceId':'service','instanceId':'mac','epoch':'epoch'}
    snapshot={'protocol':1,'deviceId':DEVICE,'selected':None,'applying':None,'displaying':None,
              'generation':0,'items':[],'health':{'status':'healthy','confirmedValidUntil':9999999999999},'services':[{'id':'service',
              'epoch':'epoch','epochExpiresAt':9999999999999,'config':{'enabled':True,'allowPreview':True}}]}
    return SimpleNamespace(config=config,snapshot=snapshot,_snapshot_lock=threading.Lock(),
                           http=Transport(url,DEVICE+'.service.publisher-secret'))

class FakeDevice:
    def __init__(self):
        self.calls=[]; self.verified=[]; self.active=0; self.max_active=0; self.lock=threading.Lock()
    def verify(self,device): self.verified.append(device)
    def frame(self,slot):
        with self.lock:
            self.calls.append(time.monotonic()); self.active+=1; self.max_active=max(self.active,self.max_active)
        try:
            time.sleep(.08)
            return base64.b64encode(bytes((1,2,3))*1152).decode()
        finally:
            with self.lock: self.active-=1
    def close(self): pass

class PreviewBridgeTest(unittest.IsolatedAsyncioTestCase):
    async def test_demand_gates_all_lan_reads_and_capability_cancels_capture(self):
        from websockets.asyncio.server import serve
        messages=[]; sockets=[]; device=FakeDevice(); created=[]
        async def handler(ws):
            sockets.append(ws)
            try:
                async for raw in ws: messages.append(json.loads(raw))
            except WebSocketException: pass
        async with serve(handler,'127.0.0.1',0) as server:
            port=server.sockets[0].getsockname()[1]; client=client_for('http://127.0.0.1:'+str(port))
            bridge=preview.PreviewBridge('.',{'agent':client},device_factory=lambda _:created.append(True) or device,
                                         status_path=None)
            task=asyncio.create_task(bridge.run())
            try:
                await self.wait_until(lambda:bool(sockets))
                await asyncio.sleep(.13)
                self.assertEqual(created,[]); self.assertEqual(device.verified,[]); self.assertEqual(device.calls,[])
                demand={'type':'demand','enabled':True,'targetFps':30,'streamId':'s1','deviceId':DEVICE}
                await sockets[-1].send(json.dumps(demand))
                await self.wait_until(lambda:len(messages)>=3)
                frames=[m for m in messages if m['type']=='frame']
                self.assertGreaterEqual(len(frames),3)
                self.assertEqual(device.verified,[DEVICE])
                self.assertEqual(device.max_active,1)
                self.assertTrue(all(len(json.dumps(m))<6144 for m in frames))
                self.assertEqual([f['sequence'] for f in frames],sorted({f['sequence'] for f in frames}))
                self.assertGreaterEqual(min(b-a for a,b in zip(device.calls,device.calls[1:])),1/preview.FPS-.001)
                await sockets[-1].send(json.dumps({**demand,'enabled':False}))
                await asyncio.sleep(.04); count=len(messages); reads=len(device.calls)
                await asyncio.sleep(.16)
                self.assertEqual(len(messages),count); self.assertEqual(len(device.calls),reads)
                await sockets[-1].send(json.dumps(demand))
                await self.wait_until(lambda:len(device.verified)==2)
                client.snapshot['services'][0]['config']['allowPreview']=False
                await asyncio.sleep(.08); count=len(messages); reads=len(device.calls)
                await asyncio.sleep(.14)
                self.assertEqual(len(messages),count); self.assertEqual(len(device.calls),reads)
                self.assertEqual(bridge.diagnostics()['demand'],False)
                self.assertNotIn('secret',json.dumps(bridge.diagnostics()))
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
                await bridge.aclose()

    async def wait_until(self,predicate,timeout=3):
        end=time.monotonic()+timeout
        while not predicate():
            if time.monotonic()>end: self.fail('Timed out waiting for preview state')
            await asyncio.sleep(.01)

class PreviewLifecycleTest(unittest.TestCase):
    def test_optional_bridge_start_stop_leaves_no_thread(self):
        bridge=preview.PreviewBridge('.',{},status_path=None)
        bridge.start()
        self.assertTrue(bridge.is_alive())
        bridge.stop()
        self.assertFalse(bridge.is_alive())
        self.assertFalse(bridge.diagnostics()['connected'])

    def test_service_eligibility_uses_nested_snapshot_config_enabled_only(self):
        client=client_for('http://localhost:1234')
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None)
        service=client.snapshot['services'][0]
        self.assertNotIn('enabled',service)
        self.assertTrue(bridge._eligible(client))
        service['config']['enabled']=False
        self.assertFalse(bridge._eligible(client))
        service['enabled']=True
        self.assertFalse(bridge._eligible(client))
        service['config']['enabled']=True
        self.assertTrue(bridge._eligible(client))
        service['enabled']=False
        self.assertTrue(bridge._eligible(client))

    def test_first_eligible_role_agent_preferred_capability_rearms_only_after_false(self):
        agent=client_for('http://localhost:1234'); notifier=client_for('http://localhost:1234')
        bridge=preview.PreviewBridge('.',{'notifier':notifier,'agent':agent},status_path=None)
        self.assertIs(bridge._choose(),agent)
        bridge._blocked[id(agent)]='capability'
        self.assertIs(bridge._choose(),notifier)
        agent.snapshot['services'][0]['config']['allowPreview']=False
        self.assertIs(bridge._choose(),notifier)
        agent.snapshot['services'][0]['config']['allowPreview']=True
        self.assertIs(bridge._choose(),agent)

class PreviewProtocolTest(unittest.IsolatedAsyncioTestCase):
    wait_until=PreviewBridgeTest.wait_until
    async def test_handshake_redirect_refuses_forwarding_authorization_and_never_retries(self):
        from websockets.asyncio.server import serve
        leaked=[]; attempts=[]
        async def target(ws): leaked.append(ws.request.headers.get('Authorization'))
        async with serve(target,'127.0.0.1',0) as destination:
            port=destination.sockets[0].getsockname()[1]
            def redirect(connection,request):
                attempts.append(request.headers.get('Authorization'))
                response=connection.respond(302,'redirect')
                response.headers['Location']='ws://127.0.0.1:'+str(port)
                return response
            async with serve(target,'127.0.0.1',0,process_request=redirect) as origin:
                url='http://127.0.0.1:'+str(origin.sockets[0].getsockname()[1])
                bridge=preview.PreviewBridge('.',{'agent':client_for(url)},status_path=None)
                task=asyncio.create_task(bridge.run())
                try:
                    await self.wait_until(lambda:bridge.diagnostics()['status']=='redirect_refused')
                    await asyncio.sleep(1.1)
                    self.assertEqual(len(attempts),1); self.assertEqual(leaked,[])
                finally:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError): await task

    async def test_auth_is_terminal_and_capability_403_waits_for_observed_false_then_true(self):
        from websockets.asyncio.server import serve
        for code in ('UNAUTHORIZED','PREVIEW_CAPABILITY_REQUIRED'):
            attempts=[]; enabled=[False]
            async def handler(ws): await ws.wait_closed()
            def reject(connection,request):
                attempts.append(time.monotonic())
                if not enabled[0]: return connection.respond(403,json.dumps({'error':code}))
            async with serve(handler,'127.0.0.1',0,process_request=reject) as server:
                url='http://127.0.0.1:'+str(server.sockets[0].getsockname()[1]); client=client_for(url)
                bridge=preview.PreviewBridge('.',{'agent':client},status_path=None)
                task=asyncio.create_task(bridge.run())
                try:
                    await self.wait_until(lambda:bool(attempts))
                    await asyncio.sleep(.15); self.assertEqual(len(attempts),1)
                    client.snapshot['services'][0]['config']['allowPreview']=False
                    await asyncio.sleep(.12)
                    enabled[0]=True; client.snapshot['services'][0]['config']['allowPreview']=True
                    if code=='PREVIEW_CAPABILITY_REQUIRED':
                        await self.wait_until(lambda:bridge.diagnostics()['connected'])
                        self.assertEqual(len(attempts),2)
                    else:
                        await asyncio.sleep(.12); self.assertEqual(len(attempts),1)
                finally:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError): await task

    async def test_late_capture_never_rewinds_and_cloud_loss_cancels_old_generation(self):
        from websockets.asyncio.server import serve
        sockets=[]; frames=[]; created=[]
        class ReorderingDevice(FakeDevice):
            def frame(self,slot):
                with self.lock:
                    self.calls.append(time.monotonic()); number=len(self.calls)
                time.sleep(.22 if number==1 else .015)
                return base64.b64encode(bytes((number%256,0,0))*1152).decode()
        device=ReorderingDevice()
        async def handler(ws):
            sockets.append(ws)
            await ws.send(json.dumps({'type':'demand','enabled':True,'targetFps':30,'streamId':'s1','deviceId':DEVICE}))
            try:
                async for raw in ws:
                    value=json.loads(raw)
                    if value['type']=='frame': frames.append(value)
            except WebSocketException: pass
        async with serve(handler,'127.0.0.1',0) as server:
            url='http://127.0.0.1:'+str(server.sockets[0].getsockname()[1])
            bridge=preview.PreviewBridge('.',{'agent':client_for(url)},status_path=None,
                                         device_factory=lambda _:created.append(True) or device)
            task=asyncio.create_task(bridge.run())
            try:
                await self.wait_until(lambda:len(frames)>=5)
                self.assertIn(1,[f['sequence'] for f in frames])
                self.assertEqual([f['sequence'] for f in frames],sorted({f['sequence'] for f in frames}))
                await sockets[-1].close()
                await asyncio.sleep(.08); reads=len(device.calls); count=len(frames)
                await asyncio.sleep(.25)
                self.assertEqual(len(device.calls),reads); self.assertEqual(len(frames),count)
                await self.wait_until(lambda:len(sockets)==2)
                await self.wait_until(lambda:len(frames)>count)
                self.assertEqual(created,[True])
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task

    async def test_no_demand_race_is_nonterminal_and_invalid_device_never_reads_lan(self):
        from websockets.asyncio.server import serve
        for wrong_device in (False,True):
            sockets=[]; frames=[]; created=[]; device=FakeDevice()
            async def handler(ws):
                sockets.append(ws)
                await ws.send('{"type":"error","code":"PREVIEW_NO_DEMAND"}')
                await ws.send(json.dumps({'type':'demand','enabled':True,'targetFps':30,'streamId':'s1',
                                          'deviceId':'0'*64 if wrong_device else DEVICE}))
                try:
                    async for raw in ws: frames.append(json.loads(raw))
                except WebSocketException: pass
            async with serve(handler,'127.0.0.1',0) as server:
                url='http://127.0.0.1:'+str(server.sockets[0].getsockname()[1])
                bridge=preview.PreviewBridge('.',{'agent':client_for(url)},status_path=None,
                                             device_factory=lambda _:created.append(True) or device)
                task=asyncio.create_task(bridge.run())
                try:
                    if wrong_device:
                        await self.wait_until(lambda:bridge.diagnostics()['status']=='protocol')
                        self.assertEqual(created,[]); self.assertEqual(device.calls,[])
                    else:
                        await self.wait_until(lambda:len(frames)>1)
                        self.assertTrue(bridge.diagnostics()['connected'])
                    self.assertEqual(bridge.diagnostics()['noDemandDropped'],1)
                finally:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError): await task

    async def test_transient_identity_transport_failure_retries_without_reconnecting_cloud(self):
        from websockets.asyncio.server import serve
        device=FakeDevice(); attempts=[]; frames=[]; created=[]
        def verify(device_id):
            device.verified.append(device_id)
            if len(device.verified)==1: raise preview.PreviewError('unavailable')
        device.verify=verify
        async def handler(ws):
            attempts.append(time.monotonic())
            await ws.send(json.dumps({'type':'demand','enabled':True,'targetFps':30,'streamId':'s1','deviceId':DEVICE}))
            try:
                async for raw in ws: frames.append(json.loads(raw))
            except WebSocketException: pass
        async with serve(handler,'127.0.0.1',0) as server:
            url='http://127.0.0.1:'+str(server.sockets[0].getsockname()[1])
            bridge=preview.PreviewBridge('.',{'agent':client_for(url)},status_path=None,
                                         device_factory=lambda _:created.append(True) or device)
            task=asyncio.create_task(bridge.run())
            try:
                await self.wait_until(lambda:bool(frames))
                self.assertEqual(len(attempts),1)
                self.assertEqual(device.verified,[DEVICE,DEVICE])
                self.assertEqual(created,[True])
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task

    async def test_heartbeat_without_demand_and_private_diagnostics_file(self):
        from websockets.asyncio.server import serve
        messages=[]
        async def handler(ws):
            try:
                async for raw in ws: messages.append(json.loads(raw))
            except WebSocketException: pass
        with tempfile.TemporaryDirectory() as runtime:
            async with serve(handler,'127.0.0.1',0) as server:
                url='http://127.0.0.1:'+str(server.sockets[0].getsockname()[1])
                bridge=preview.PreviewBridge(runtime,{'agent':client_for(url)})
                task=asyncio.create_task(bridge.run())
                try:
                    await self.wait_until(lambda:bool(messages),timeout=6)
                    self.assertEqual(messages,[{'type':'heartbeat'}])
                    path=Path(runtime)/'preview-status.json'
                    self.assertTrue(path.exists())
                    self.assertEqual(path.stat().st_mode & 0o777,0o600)
                    raw=path.read_text()
                    self.assertNotIn('publisher-secret',raw); self.assertNotIn('127.0.0.1',raw)
                    self.assertNotIn('pixels',raw)
                    self.assertEqual(json.loads(raw)['captureRequested'],0)
                finally:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError): await task


class PreviewDisplayPriorityTest(unittest.IsolatedAsyncioTestCase):
    wait_until=PreviewBridgeTest.wait_until

    @staticmethod
    def confirmed(client,version=1):
        client.snapshot.update(selected='own',applying=None,generation=3,
            displaying={'itemKey':'own','generation':3,'confirmedValidUntil':9999999999999},
            items=[{'itemKey':'own','version':version,'state':'displaying',
                'coverageProof':{'version':version,'validUntil':9999999999999,
                    'controller':{'itemKey':'own','generation':3}}}])

    async def test_display_fence_requires_confirmed_current_version_and_healthy_device(self):
        import copy
        client=client_for('http://localhost:1234')
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None)
        self.confirmed(client)
        stable=copy.deepcopy(client.snapshot)
        self.assertEqual(bridge._display_fence(client),(3,'own',1))
        for mutation in (
                lambda s:s.update(applying='own'),
                lambda s:s['health'].update(status='unknown'),
                lambda s:s['displaying'].update(generation=2),
                lambda s:s['displaying'].update(confirmedValidUntil=0),
                lambda s:s['items'][0].update(version=2),
                lambda s:s['items'][0].update(state='applying'),
                lambda s:s['items'][0]['coverageProof'].update(validUntil=0),
                lambda s:s.pop('applying')):
            client.snapshot=copy.deepcopy(stable);mutation(client.snapshot)
            self.assertIsNone(bridge._display_fence(client))
        client.snapshot=stable;client.snapshot['items']=[]
        # A scoped producer may only see the opaque global display confirmation.
        self.assertEqual(bridge._display_fence(client),(3,'own',None))

    async def test_applying_pauses_before_device_factory_then_resumes_single_worker(self):
        from concurrent.futures import ThreadPoolExecutor
        client=client_for('http://localhost:1234');client.snapshot['applying']='pending'
        device=FakeDevice();created=[]
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None,
            device_factory=lambda _:created.append(True) or device)
        bridge._executor=ThreadPoolExecutor(max_workers=1)
        bridge._client=client;bridge._demand=True
        task=asyncio.create_task(bridge._capture(client,DEVICE))
        try:
            await self.wait_until(lambda:bridge.diagnostics()['pausedForDisplay'])
            await asyncio.sleep(.06)
            self.assertEqual(created,[]);self.assertEqual(device.verified,[]);self.assertEqual(device.calls,[])
            client.snapshot['applying']=None
            await self.wait_until(lambda:bridge.diagnostics()['captured']==1)
            self.assertEqual(created,[True]);self.assertEqual(device.verified,[DEVICE])
            client.snapshot['applying']='pending'
            await self.wait_until(lambda:bridge.diagnostics()['pausedForDisplay'])
            reads=len(device.calls)
            await asyncio.sleep(.55)
            self.assertEqual(len(device.calls),reads);self.assertTrue(bridge._latest.empty())
            self.assertEqual(bridge.diagnostics()['actualTargetFps'],2)
            self.assertEqual(bridge.diagnostics()['maxInFlight'],1)
        finally:
            task.cancel()
            await asyncio.gather(task,return_exceptions=True)
            await bridge.aclose()

    async def test_inflight_capture_is_discarded_after_display_change_and_rate_gate_is_hard(self):
        from concurrent.futures import ThreadPoolExecutor
        client=client_for('http://localhost:1234');self.confirmed(client)
        device=FakeDevice()
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None)
        bridge._executor=ThreadPoolExecutor(max_workers=1)
        bridge._client=client;bridge._demand=True
        try:
            self.assertTrue(bridge._submit_frame(device,0,client,0))
            await self.wait_until(lambda:bool(device.calls))
            client.snapshot['items'][0]['version']=2
            await asyncio.gather(*list(bridge._pending));await asyncio.sleep(0)
            self.assertTrue(bridge._latest.empty())
            self.assertEqual(bridge.diagnostics()['invalidatedDropped'],1)
            self.confirmed(client,2)
            self.assertFalse(bridge._submit_frame(device,0,client,0))
            self.assertEqual(bridge.diagnostics()['rateLimitedSkipped'],1)
            await asyncio.sleep(.5)
            self.assertTrue(bridge._submit_frame(device,0,client,0))
            await asyncio.gather(*list(bridge._pending));await asyncio.sleep(0)
            self.assertEqual(bridge._latest._queue[0][1]['_displayFence'],(3,'own',2))
            client.snapshot['applying']='own'
            from types import SimpleNamespace
            sent=[]
            async def send(raw):sent.append(raw)
            sending=asyncio.create_task(bridge._send(SimpleNamespace(send=send),client))
            try:
                await self.wait_until(lambda:bridge.diagnostics()['displayPausedDropped']==1)
                self.assertEqual(sent,[])
            finally:
                sending.cancel();await asyncio.gather(sending,return_exceptions=True)
        finally:await bridge.aclose()


class PreviewSchedulingTest(unittest.IsolatedAsyncioTestCase):
    wait_until=PreviewBridgeTest.wait_until

    async def test_drop_diagnostics_distinguish_completion_order_queue_replacement_and_invalidation(self):
        from concurrent.futures import ThreadPoolExecutor
        client=client_for('http://localhost:1234'); device=FakeDevice()
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None)
        bridge._executor=ThreadPoolExecutor(max_workers=1)
        bridge._client=client; bridge._demand=True
        try:
            for _ in range(2):
                bridge._last_capture_started=-float('inf')
                bridge._submit_frame(device,0,client,0)
                await asyncio.gather(*list(bridge._pending))
            bridge._latest.get_nowait()
            bridge._latest.put_nowait((0,{'sequence':100}))
            bridge._last_capture_started=-float('inf')
            bridge._submit_frame(device,0,client,0)
            await asyncio.gather(*list(bridge._pending))
            bridge._invalidate()
            diag=bridge.diagnostics()
            self.assertEqual(diag['dropped'],3)
            self.assertEqual(diag.get('supersededDropped'),1)
            self.assertEqual(diag.get('outOfOrderDropped'),1)
            self.assertEqual(diag.get('invalidatedDropped'),1)
            self.assertEqual(diag.get('noDemandDropped'),0)
        finally:
            await bridge.aclose()

    async def test_single_flight_refuses_second_read_and_preserves_newer_queued_frame(self):
        from concurrent.futures import ThreadPoolExecutor
        device=FakeDevice();release=threading.Event()
        def frame(slot):
            release.wait(timeout=1)
            return base64.b64encode(bytes((slot,0,0))*1152).decode()
        device.frame=frame
        client=client_for('http://localhost:1234')
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None)
        bridge._executor=ThreadPoolExecutor(max_workers=1)
        bridge._client=client;bridge._demand=True
        try:
            self.assertTrue(bridge._submit_frame(device,0,client,0))
            self.assertFalse(bridge._submit_frame(device,0,client,0))
            self.assertFalse(bridge._submit_frame(device,1,client,0))
            self.assertEqual(len(bridge._pending),1)
            release.set();await asyncio.gather(*list(bridge._pending))
            bridge._latest=asyncio.Queue(maxsize=1)
            bridge._latest.put_nowait((0,{'sequence':100}))
            bridge._last_capture_started=-float('inf')
            self.assertTrue(bridge._submit_frame(device,0,client,0))
            await asyncio.gather(*list(bridge._pending))
            await self.wait_until(lambda:bridge.diagnostics()['captured']==2)
            _,latest=bridge._latest.get_nowait()
            self.assertEqual(latest['sequence'],100)
            self.assertEqual(bridge.diagnostics()['captureErrors'],0)
        finally:
            release.set();await bridge.aclose()

    async def test_identity_read_reserves_slot_until_worker_exits_after_cancellation(self):
        from concurrent.futures import ThreadPoolExecutor
        started=threading.Event(); release=threading.Event()
        bridge=preview.PreviewBridge('.',{},status_path=None)
        bridge._executor=ThreadPoolExecutor(max_workers=1)
        def identify():
            started.set(); release.wait(timeout=1)
        task=asyncio.create_task(bridge._offload(identify))
        await self.wait_until(started.is_set)
        try:
            self.assertTrue(bridge._busy[0])
            task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
            self.assertTrue(bridge._busy[0])
        finally:
            release.set()
            if not task.done():
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
            await bridge.aclose()
        self.assertFalse(bridge._busy[0])

    async def test_one_busy_slot_skips_ticks_and_cancellation_discards_late_frame(self):
        from concurrent.futures import ThreadPoolExecutor
        class SlowDevice(FakeDevice):
            def frame(self,slot):
                with self.lock:
                    self.calls.append(time.monotonic()); self.active+=1; self.max_active=max(self.max_active,self.active)
                try:
                    time.sleep(.8)
                    return base64.b64encode(bytes((slot,0,0))*1152).decode()
                finally:
                    with self.lock: self.active-=1
        device=SlowDevice(); client=client_for('http://localhost:1234')
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None,device_factory=lambda _:device)
        bridge._executor=ThreadPoolExecutor(max_workers=1)
        bridge._client=client; bridge._demand=True
        task=asyncio.create_task(bridge._capture(client,DEVICE))
        try:
            await self.wait_until(lambda:bridge.diagnostics()['busySkipped']>1)
            self.assertEqual(device.max_active,1)
            self.assertEqual(len(device.calls),1)
        finally:
            bridge._invalidate(); task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
            await bridge.aclose()
        self.assertEqual(device.active,0)
        self.assertTrue(bridge._latest.empty())


class PreviewReviewRegressionTest(unittest.IsolatedAsyncioTestCase):
    wait_until=PreviewBridgeTest.wait_until

    async def test_isolated_frame_timeout_does_not_disconnect_the_publisher(self):
        from websockets.asyncio.server import serve
        device=FakeDevice(); sockets=[]; frames=[]
        original=device.frame; attempts=[0]
        def one_timeout(slot):
            attempts[0]+=1
            if attempts[0]==1: raise preview.PreviewError('timeout')
            return original(slot)
        device.frame=one_timeout
        async def handler(ws):
            sockets.append(ws)
            await ws.send(json.dumps({'type':'demand','enabled':True,'targetFps':30,'streamId':'s1','deviceId':DEVICE}))
            try:
                async for raw in ws:
                    value=json.loads(raw)
                    if value['type']=='frame': frames.append(value)
            except WebSocketException: pass
        async with serve(handler,'127.0.0.1',0) as server:
            url='http://127.0.0.1:'+str(server.sockets[0].getsockname()[1])
            bridge=preview.PreviewBridge('.',{'agent':client_for(url)},status_path=None,device_factory=lambda _:device)
            task=asyncio.create_task(bridge.run())
            try:
                await self.wait_until(lambda:len(frames)>=3)
                self.assertEqual(len(sockets),1)
                self.assertTrue(bridge.diagnostics()['connected'])
                self.assertEqual(bridge.diagnostics()['captureErrors'],1)
                self.assertEqual(device.verified,[DEVICE])
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task

    async def test_lan_retry_is_capped_without_invalidating_generation(self):
        client=client_for('http://localhost:1234')
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None)
        bridge._client=client; bridge._demand=True
        for expected in (.1,.2,.4,.8,1.6,2,2,2):
            with patch.object(preview.time,'monotonic',return_value=100):
                bridge._capture_failed(client,0,preview.PreviewError('timeout'))
            self.assertAlmostEqual(bridge._capture_retry_at,100+expected)
            self.assertEqual(bridge._generation,0)
            self.assertTrue(bridge._demand)

    async def test_frame_transport_failure_backs_off_lan_reads_without_reconnecting_cloud(self):
        from websockets.asyncio.server import serve
        device=FakeDevice(); sockets=[]
        def unavailable(slot):
            device.calls.append(time.monotonic())
            raise preview.PreviewError('unavailable')
        device.frame=unavailable
        async def handler(ws):
            sockets.append(ws)
            await ws.send(json.dumps({'type':'demand','enabled':True,'targetFps':30,'streamId':'s1','deviceId':DEVICE}))
            await ws.wait_closed()
        async with serve(handler,'127.0.0.1',0) as server:
            url='http://127.0.0.1:'+str(server.sockets[0].getsockname()[1])
            bridge=preview.PreviewBridge('.',{'agent':client_for(url)},status_path=None,device_factory=lambda _:device)
            task=asyncio.create_task(bridge.run())
            try:
                await self.wait_until(lambda:bool(device.calls))
                await self.wait_until(lambda:len(device.calls)>=3)
                self.assertTrue(bridge.diagnostics()['demand'])
                self.assertTrue(bridge.diagnostics()['connected'])
                self.assertEqual(len(sockets),1)
                self.assertGreaterEqual(device.calls[1]-device.calls[0],.09)
                self.assertGreaterEqual(device.calls[2]-device.calls[1],.19)
                self.assertEqual(len(sockets),1)
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task

    async def test_delayed_factory_worker_rechecks_demand_before_reading_credentials(self):
        from concurrent.futures import ThreadPoolExecutor
        started=threading.Event(); release=threading.Event(); factories=[]
        client=client_for('http://localhost:1234')
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None,
                                     device_factory=lambda _:factories.append(True) or FakeDevice())
        bridge._executor=ThreadPoolExecutor(max_workers=1)
        def occupy(): started.set(); release.wait(timeout=2)
        occupied=bridge._executor.submit(occupy)
        await self.wait_until(started.is_set)
        bridge._client=client; bridge._demand=True
        task=asyncio.create_task(bridge._capture(client,DEVICE))
        try:
            await self.wait_until(lambda:bridge._device_future is not None)
            bridge._invalidate(); release.set()
            await asyncio.wrap_future(occupied)
            await asyncio.gather(*list(bridge._pending))
            await asyncio.sleep(.03)
            self.assertEqual(factories,[])
            bridge._demand=True
            await self.wait_until(lambda:factories==[True])
        finally:
            release.set(); bridge._invalidate(); task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
            await bridge.aclose()

    async def test_distinct_python310_asyncio_timeout_is_retried_by_supervisor(self):
        # Python 3.10 has a separate asyncio.TimeoutError class. Simulate that
        # distinction even when this suite runs on Python 3.11 or newer.
        class LegacyAsyncioTimeout(Exception): pass
        attempts=[]
        class TimeoutConnect:
            def __init__(self,*args,**kwargs): pass
            async def __aenter__(self):
                attempts.append(time.monotonic()); raise LegacyAsyncioTimeout()
            async def __aexit__(self,*args): pass
        client=client_for('http://localhost:1234')
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None)
        with patch.object(preview.asyncio,'TimeoutError',LegacyAsyncioTimeout), \
             patch.object(preview,'NoRedirectConnect',TimeoutConnect):
            task=asyncio.create_task(bridge.run())
            try:
                await self.wait_until(lambda:bool(attempts))
                await asyncio.sleep(.05)
                self.assertFalse(task.done())
                await self.wait_until(lambda:len(attempts)==2)
                self.assertGreaterEqual(attempts[1]-attempts[0],.9)
            finally:
                task.cancel()
                result=await asyncio.gather(task,return_exceptions=True)
                self.assertIsInstance(result[0],asyncio.CancelledError)

    async def test_invalidating_demand_cancels_blocked_frame_send_before_completion(self):
        started=asyncio.Event(); release=asyncio.Event(); completed=[]
        class BlockedSocket:
            async def send(self,raw):
                started.set(); await release.wait(); completed.append(raw)
        client=client_for('http://localhost:1234')
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None)
        bridge._client=client; bridge._demand=True
        bridge._latest.put_nowait((0,{'type':'frame','sequence':1,'capturedAt':1,'pixels':'test'}))
        task=asyncio.create_task(bridge._send(BlockedSocket(),client))
        try:
            await started.wait()
            bridge._invalidate()
            await asyncio.sleep(.02)
            release.set(); await asyncio.sleep(.02)
            self.assertEqual(completed,[])
            self.assertEqual(bridge.diagnostics()['sent'],0)
        finally:
            task.cancel()
            await asyncio.gather(task,return_exceptions=True)


class PreviewBackoffTest(unittest.IsolatedAsyncioTestCase):
    async def run_sessions(self,*,healthy=None):
        from types import SimpleNamespace
        clock=[100.0]; attempts=[]; ended=[]
        client=client_for('http://localhost:1234')
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None)
        real_sleep=asyncio.sleep
        async def advance(delay):
            clock[0]+=delay
            await real_sleep(0)
        class Connected:
            def __init__(self,*args,**kwargs): pass
            async def __aenter__(self): return object()
            async def __aexit__(self,*args): pass
        async def session(*args):
            attempts.append(clock[0])
            if len(attempts)==3:
                if healthy=='frame': bridge._count('sent')
                if healthy=='sustained': clock[0]+=15
            if len(attempts)==4: bridge._stop.set()
            ended.append(clock[0])
            raise preview.PreviewError('unavailable')
        fake_time=SimpleNamespace(monotonic=lambda:clock[0],time=time.time)
        with patch.object(preview,'time',fake_time), patch.object(preview.asyncio,'sleep',advance), \
             patch.object(preview,'NoRedirectConnect',Connected), patch.object(bridge,'_session',session):
            await bridge.run()
        self.last_diagnostics=bridge.diagnostics()
        return [attempts[i+1]-ended[i] for i in range(3)]

    async def test_session_end_diagnostics_record_actual_backoff_without_peer_payload(self):
        await self.run_sessions()
        rows=self.last_diagnostics['recentSessionEnds']
        self.assertEqual(len(rows),4)
        self.assertEqual([r['plannedRetryDelayMs']for r in rows],[1000,2000,4000,None])
        self.assertEqual({r['code']for r in rows},{'unavailable'})
        self.assertTrue(all(r['durationMs']>=0 and type(r['atMs'])is int for r in rows))
        self.assertTrue(all(r['sentFrames']==0 and r['webSocketCode']is None for r in rows))

    async def test_three_consecutive_capture_failures_keep_increasing_backoff(self):
        delays=await self.run_sessions()
        for actual,expected in zip(delays,(1,2,4)):
            self.assertGreaterEqual(actual,expected-.001)
            self.assertLess(actual,expected+.1)

    async def test_frame_delivery_or_sustained_session_resets_backoff(self):
        for healthy in ('frame','sustained'):
            with self.subTest(healthy=healthy):
                delays=await self.run_sessions(healthy=healthy)
                for actual,expected in zip(delays,(1,2,1)):
                    self.assertGreaterEqual(actual,expected-.001)
                    self.assertLess(actual,expected+.1)


class PreviewRelayCloseTest(unittest.IsolatedAsyncioTestCase):
    wait_until=PreviewBridgeTest.wait_until

    async def test_idle_and_disconnected_policy_closes_retry_but_auth_close_is_terminal(self):
        from websockets.asyncio.server import serve
        for reason in ('PREVIEW_PUBLISHER_IDLE','PREVIEW_DISCONNECTED','UNAUTHORIZED'):
            with self.subTest(reason=reason):
                attempts=[]; factories=[]
                async def handler(ws):
                    attempts.append(time.monotonic())
                    if len(attempts)==1: await ws.close(code=1008,reason=reason)
                    else: await ws.wait_closed()
                async with serve(handler,'127.0.0.1',0) as server:
                    url='http://127.0.0.1:'+str(server.sockets[0].getsockname()[1])
                    bridge=preview.PreviewBridge('.',{'agent':client_for(url)},status_path=None,
                                                 device_factory=lambda _:factories.append(True) or FakeDevice())
                    task=asyncio.create_task(bridge.run())
                    try:
                        await self.wait_until(lambda:len(attempts)>=1)
                        if reason=='UNAUTHORIZED':
                            await asyncio.sleep(1.2)
                            self.assertEqual(len(attempts),1)
                        else:
                            await self.wait_until(lambda:len(attempts)==2 and bridge.diagnostics()['connected'])
                            self.assertGreaterEqual(attempts[1]-attempts[0],.9)
                        self.assertEqual(factories,[])
                        rows=bridge.diagnostics()['recentSessionEnds']
                        self.assertEqual(rows[0]['code'],reason)
                        self.assertEqual(rows[0]['webSocketCode'],1008)
                        self.assertEqual(rows[0]['plannedRetryDelayMs'],None if reason=='UNAUTHORIZED' else 1000)
                    finally:
                        task.cancel()
                        with self.assertRaises(asyncio.CancelledError): await task


class PreviewCaptureClockTest(unittest.IsolatedAsyncioTestCase):
    wait_until=PreviewBridgeTest.wait_until

    async def simulated_samples(self,*,wake_lateness=(.001,.003,.006),stall=0,restart=False,bookkeeping=0):
        from types import SimpleNamespace
        clock=[100.0]; started=[]; sleeps=[]
        loop=asyncio.get_running_loop(); real_sleep=asyncio.sleep
        client=client_for('http://localhost:1234'); device=FakeDevice()
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None,device_factory=lambda _:device)
        bridge._client=client; bridge._demand=True
        def immediate_worker(executor,work):
            future=loop.create_future()
            future.set_result(work())
            return future
        async def advance(delay):
            self.assertGreaterEqual(delay,0)
            lateness=wake_lateness[len(sleeps)%len(wake_lateness)]
            sleeps.append(delay)
            clock[0]+=delay+lateness
            if stall and len(sleeps)==4: clock[0]+=stall
            if restart and not bridge._demand: bridge._demand=True
            await real_sleep(0)
        def submit(*args):
            started.append(clock[0])
            if restart and len(started)==4: bridge._invalidate()
            if len(started)==121: raise asyncio.CancelledError()
            clock[0]+=bookkeeping
        bridge._submit_frame=submit
        simulated_loop=SimpleNamespace(time=lambda:clock[0],run_in_executor=immediate_worker)
        with patch.object(preview.asyncio,'get_running_loop',return_value=simulated_loop), \
             patch.object(preview.asyncio,'sleep',advance):
            with self.assertRaises(asyncio.CancelledError): await bridge._capture(client,DEVICE)
        self.assertEqual(device.verified,[DEVICE]*(2 if restart else 1))
        self.assertGreaterEqual(len(sleeps),len(started)-1,'Capture must yield between ticks, including overruns')
        return started

    async def test_positive_wake_jitter_never_exceeds_two_fps_or_repays_missed_time(self):
        started=await self.simulated_samples()
        # A late wake can reduce throughput; preserving a strict500ms gap is
        # more important than recovering the nominal phase or average rate.
        self.assertGreaterEqual(started[-1]-started[0],120/preview.FPS)
        self.assertLessEqual(started[-1]-started[0],120/preview.FPS+.006*122)
        self.assertGreaterEqual(min(b-a for a,b in zip(started,started[1:])),1/preview.FPS-1e-9)

    async def test_late_wake_preserves_minimum_gap_and_long_stall_skips_ticks(self):
        for lateness,stall in (((0,0,.021,0),0),((0,),.12)):
            with self.subTest(lateness=lateness,stall=stall):
                started=await self.simulated_samples(wake_lateness=lateness,stall=stall)
                intervals=[b-a for a,b in zip(started,started[1:])]
                self.assertGreaterEqual(min(intervals),1/preview.FPS-1e-9)
                if stall: self.assertGreater(intervals[3],.12)

    async def test_resumed_demand_reverifies_and_resets_phase_with_minimum_gap(self):
        started=await self.simulated_samples(wake_lateness=(0,),restart=True)
        self.assertAlmostEqual(started[4]-started[3],1/preview.FPS,places=8)
        self.assertGreaterEqual(min(b-a for a,b in zip(started,started[1:])),1/preview.FPS-1e-9)

    async def test_overrun_bookkeeping_yields_to_session_tasks_between_ticks(self):
        started=await self.simulated_samples(wake_lateness=(0,),bookkeeping=.04)
        self.assertGreaterEqual(min(b-a for a,b in zip(started,started[1:])),1/preview.FPS-1e-9)

    async def scheduled_samples(self,*,bookkeeping=0,stall=False,partial_stall=False):
        from concurrent.futures import ThreadPoolExecutor
        loop=asyncio.get_running_loop(); started=[]
        client=client_for('http://localhost:1234'); device=FakeDevice()
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None,device_factory=lambda _:device)
        bridge._executor=ThreadPoolExecutor(max_workers=1)
        bridge._client=client; bridge._demand=True
        def submit(*args):
            started.append(loop.time())
            # Model synchronous scheduler/callback bookkeeping without replacing
            # either global clock. The transport is outside this timing test.
            if bookkeeping: time.sleep(bookkeeping)
            if stall and len(started)==4: loop.call_later(.01,time.sleep,.7)
            if partial_stall and len(started)==4: loop.call_later(.01,time.sleep,.54)
        bridge._submit_frame=submit
        old_warning=loop.slow_callback_duration; loop.slow_callback_duration=.5
        task=asyncio.create_task(bridge._capture(client,DEVICE))
        try:
            await self.wait_until(lambda:len(started)>=6,timeout=5)
        finally:
            bridge._invalidate(); task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
            await bridge.aclose()
            loop.slow_callback_duration=old_warning
        return started

    async def test_capture_deadline_absorbs_bookkeeping_instead_of_adding_a_full_sleep(self):
        import statistics
        started=await self.scheduled_samples(bookkeeping=.018)
        intervals=[b-a for a,b in zip(started,started[1:])]
        self.assertLess(statistics.median(intervals),1/preview.FPS+.009)
        self.assertGreaterEqual(min(intervals),1/preview.FPS-.001)

    async def test_partial_tick_lateness_does_not_create_a_short_catchup_interval(self):
        started=await self.scheduled_samples(partial_stall=True)
        intervals=[b-a for a,b in zip(started,started[1:])]
        self.assertGreater(intervals[3],.54)
        self.assertGreaterEqual(intervals[4],1/preview.FPS-.001)

    async def test_stalled_event_loop_skips_missed_ticks_without_catchup_burst(self):
        started=await self.scheduled_samples(stall=True)
        intervals=[b-a for a,b in zip(started,started[1:])]
        self.assertGreater(intervals[3],.7)
        self.assertGreaterEqual(min(intervals[4:]),1/preview.FPS-.001)




class PreviewTransientRejectionTest(unittest.IsolatedAsyncioTestCase):
    wait_until=PreviewBridgeTest.wait_until

    async def test_transient_frame_rejection_reconnects_with_fresh_identity_and_stream(self):
        from websockets.asyncio.server import serve
        for code in ('PREVIEW_STALE_FRAME','PREVIEW_RATE_LIMIT','PREVIEW_SEQUENCE'):
            for close_only in (False,True):
                with self.subTest(code=code,close_only=close_only):
                    attempts=[]; frames=[]; device=FakeDevice()
                    async def handler(ws):
                        attempts.append(time.monotonic()); number=len(attempts)
                        await ws.send(json.dumps({'type':'demand','enabled':True,'targetFps':30,
                                                  'streamId':'stream'+str(number),'deviceId':DEVICE}))
                        try:
                            if number==1:
                                await ws.recv()  # A working connection can fail later under jitter.
                                if not close_only: await ws.send(json.dumps({'type':'error','code':code}))
                                await ws.close(code=1008,reason=code)
                            else:
                                async for raw in ws:
                                    value=json.loads(raw)
                                    if value.get('type')=='frame': frames.append(value)
                        except WebSocketException: pass
                    async with serve(handler,'127.0.0.1',0) as server:
                        url='http://127.0.0.1:'+str(server.sockets[0].getsockname()[1])
                        bridge=preview.PreviewBridge('.',{'agent':client_for(url)},status_path=None,
                                                     device_factory=lambda _:device)
                        task=asyncio.create_task(bridge.run())
                        try:
                            await self.wait_until(lambda:bool(frames))
                            self.assertEqual(len(attempts),2)
                            self.assertGreaterEqual(attempts[1]-attempts[0],.9)
                            self.assertEqual(device.verified,[DEVICE,DEVICE])
                            self.assertTrue(bridge.diagnostics()['connected'])
                            self.assertEqual(bridge.diagnostics()['lastCloudError'],code)
                            ended=bridge.diagnostics()['recentSessionEnds'][0]
                            self.assertIn(ended['code'],(code,'unavailable'))
                            self.assertGreaterEqual(ended['sentFrames'],1)
                            self.assertIsNotNone(ended['firstFrameSentAtMs'])
                            self.assertGreaterEqual(ended['lastFrameSentAtMs'],ended['firstFrameSentAtMs'])
                            self.assertNotIn('secret',json.dumps(bridge.diagnostics()))
                        finally:
                            task.cancel()
                            with self.assertRaises(asyncio.CancelledError): await task

    async def test_unknown_or_malformed_rejections_stay_terminal_without_echoing_peer_data(self):
        from websockets.asyncio.server import serve
        for rejection in ({'type':'error','code':'private-peer-data'},
                          {'type':'error','code':'PREVIEW_RATE_LIMIT','extra':'private-peer-data'}):
            attempts=[]; device=FakeDevice()
            async def handler(ws):
                attempts.append(True)
                await ws.send(json.dumps(rejection))
                await ws.wait_closed()
            async with serve(handler,'127.0.0.1',0) as server:
                url='http://127.0.0.1:'+str(server.sockets[0].getsockname()[1])
                bridge=preview.PreviewBridge('.',{'agent':client_for(url)},status_path=None,
                                             device_factory=lambda _:device)
                task=asyncio.create_task(bridge.run())
                try:
                    await self.wait_until(lambda:bridge.diagnostics()['status']=='protocol')
                    await asyncio.sleep(1.1)
                    self.assertEqual(len(attempts),1)
                    self.assertEqual(device.calls,[])
                    self.assertNotIn('private-peer-data',json.dumps(bridge.diagnostics()))
                finally:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError): await task


class PreviewSessionDiagnosticsTest(unittest.IsolatedAsyncioTestCase):
    async def exit_diagnostic(self,error=None,close_code=None):
        from types import SimpleNamespace
        bridge=preview.PreviewBridge('.',{'agent':client_for('http://localhost:1234')},status_path=None)
        class Connected:
            def __init__(self,*args,**kwargs):pass
            async def __aenter__(self):return SimpleNamespace(close_code=close_code)
            async def __aexit__(self,*args):pass
        async def session(*args):
            bridge._stop.set()
            if error is not None:raise error
        with patch.object(preview,'NoRedirectConnect',Connected),patch.object(bridge,'_session',session):
            if type(error)is RuntimeError:
                with self.assertRaises(RuntimeError):await bridge.run()
            else:await bridge.run()
        return bridge.diagnostics()['recentSessionEnds'][-1]

    async def test_normal_eof_ping_and_transport_exits_keep_only_finite_categories(self):
        from websockets.exceptions import ConnectionClosedError
        from websockets.frames import Close
        cases=[(None,1000,'normal_close',1000),
               (ConnectionClosedError(None,None),None,'no_close_frame',None),
               (ConnectionClosedError(None,Close(1011,'keepalive ping timeout')),None,'ping_timeout',None),
               (ConnectionClosedError(Close(1012,'private-peer-payload'),None),None,'websocket_closed',1012),
               (ConnectionClosedError(Close(1008,'transport_error'),None),None,'websocket_closed',1008),
               (WebSocketException('private-peer-payload'),None,'websocket_error',None),
               (OSError('private-peer-payload'),None,'transport_error',None),
               (TimeoutError('private-peer-payload'),None,'transport_timeout',None),
               (RuntimeError('private-peer-payload'),None,'unexpected_error',None)]
        for error,close_code,expected,expected_ws in cases:
            with self.subTest(expected=expected,expected_ws=expected_ws):
                row=await self.exit_diagnostic(error,close_code)
                self.assertEqual(row['code'],expected)
                self.assertEqual(row['webSocketCode'],expected_ws)
                self.assertNotIn('private-peer-payload',json.dumps(row))
                self.assertIsNone(row['plannedRetryDelayMs'])

    async def test_legacy_asyncio_timeout_is_distinguished_from_other_transport_errors(self):
        class LegacyAsyncTimeout(Exception):pass
        with patch.object(preview.asyncio,'TimeoutError',LegacyAsyncTimeout):
            row=await self.exit_diagnostic(LegacyAsyncTimeout('private-peer-payload'))
        self.assertEqual(row['code'],'transport_timeout')
        self.assertNotIn('private-peer-payload',json.dumps(row))

    async def test_history_is_bounded_copied_and_never_keeps_unknown_values(self):
        bridge=preview.PreviewBridge('.',{},status_path=None)
        for _ in range(40):
            bridge._record_exit('private-peer-payload',time.monotonic(),0,ws_code=4242,retry_ms='private-peer-payload',http_status='private-peer-payload')
        result=bridge.diagnostics()
        self.assertEqual(len(result['recentSessionEnds']),16)
        self.assertTrue(all(row['code']=='unknown'and row['webSocketCode']is None and row['httpStatus']is None and row['plannedRetryDelayMs']is None for row in result['recentSessionEnds']))
        self.assertNotIn('private-peer-payload',json.dumps(result))
        result['recentSessionEnds'][0]['code']='mutated'
        self.assertEqual(bridge.diagnostics()['recentSessionEnds'][0]['code'],'unknown')
        bridge._record_exit('handshake_rejected',None,0,retry_ms=1000,http_status=503)
        result=bridge.diagnostics();result['lastConnectFailure']['code']='mutated'
        self.assertEqual(bridge.diagnostics()['lastConnectFailure']['code'],'handshake_rejected')
        self.assertEqual(bridge.diagnostics()['lastConnectFailure']['httpStatus'],503)
        self.assertEqual(len(bridge.diagnostics()['recentSessionEnds']),16)

    async def test_conflict_handshake_preserves_only_exact_bounded_protocol_codes(self):
        from types import SimpleNamespace
        from websockets.exceptions import InvalidStatus
        cases=[(409,b'{"error":"PREVIEW_PUBLISHER_EXISTS"}','PREVIEW_PUBLISHER_EXISTS'),
               (409,b'{"error":"EPOCH_EXPIRED"}','EPOCH_EXPIRED'),
               (409,b'{"error":"private-peer-payload"}','handshake_rejected'),
               (409,b'[]','handshake_rejected'),
               (409,b'\xff','handshake_rejected'),
               (409,b'x'*2049,'handshake_rejected'),
               (503,b'{"error":"PREVIEW_PUBLISHER_EXISTS"}','handshake_rejected')]
        for status,raw,expected in cases:
            with self.subTest(status=status,expected=expected):
                bridge=preview.PreviewBridge('.',{'agent':client_for('http://localhost:1234')},status_path=None)
                class Rejected:
                    def __init__(self,*args,**kwargs):pass
                    async def __aenter__(self):
                        bridge._stop.set()
                        raise InvalidStatus(SimpleNamespace(status_code=status,reason_phrase='test',body=raw))
                    async def __aexit__(self,*args):pass
                with patch.object(preview,'NoRedirectConnect',Rejected):await bridge.run()
                diag=bridge.diagnostics()
                self.assertEqual(diag['lastConnectFailure']['code'],expected)
                self.assertEqual(diag['lastConnectFailure']['httpStatus'],status)
                self.assertEqual(diag['recentSessionEnds'],[])
                self.assertNotIn('private-peer-payload',json.dumps(diag))

    async def test_capture_history_distinguishes_late_completion_from_current_retry(self):
        client=client_for('http://localhost:1234');bridge=preview.PreviewBridge('.',{'agent':client},status_path=None)
        for _ in range(12):bridge._capture_failed(client,0,preview.PreviewError('private-peer-payload'))
        self.assertEqual(len(bridge.diagnostics()['recentCaptureErrors']),8)
        self.assertTrue(all(not r['currentContext']and r['code']=='unknown'for r in bridge.diagnostics()['recentCaptureErrors']))
        bridge._client=client;bridge._demand=True
        bridge._capture_failed(client,0,preview.PreviewError('unavailable'))
        snapshot=bridge.diagnostics();last=snapshot['recentCaptureErrors'][-1]
        self.assertTrue(last['currentContext']);self.assertEqual(last['code'],'unavailable')
        self.assertEqual(snapshot['captureRetries'],1)
        self.assertNotIn('private-peer-payload',json.dumps(snapshot))
        last['code']='mutated'
        self.assertEqual(bridge.diagnostics()['recentCaptureErrors'][-1]['code'],'unavailable')


if __name__=='__main__': unittest.main()
