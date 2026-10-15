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
                status=getattr(owner,'response_status',200)
                self.send_response(status)
                if status==302: self.send_header('Location','http://127.0.0.1:1/private-secret')
                if getattr(owner,'close_response',False): self.send_header('Connection','close')
                self.send_header('Content-Length',str(len(body))); self.end_headers()
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
    snapshot={'protocol':1,'deviceId':DEVICE,'services':[{'id':'service','enabled':True,
              'epoch':'epoch','epochExpiresAt':9999999999999,'config':{'allowPreview':True}}]}
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
                self.assertLessEqual(device.max_active,4)
                self.assertTrue(all(len(json.dumps(m))<6144 for m in frames))
                self.assertEqual([f['sequence'] for f in frames],sorted({f['sequence'] for f in frames}))
                self.assertGreaterEqual(min(b-a for a,b in zip(device.calls,device.calls[1:])),.024)
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
                self.assertNotIn(1,[f['sequence'] for f in frames])
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
                finally:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError): await task

    async def test_transient_identity_transport_failure_retries_without_rereading_credentials(self):
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
                self.assertEqual(len(attempts),2)
                self.assertGreaterEqual(attempts[1]-attempts[0],.9)
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


class PreviewSchedulingTest(unittest.IsolatedAsyncioTestCase):
    wait_until=PreviewBridgeTest.wait_until

    async def test_latest_queue_keeps_newer_completion_when_callbacks_arrive_together(self):
        from concurrent.futures import ThreadPoolExecutor
        device=FakeDevice(); release=threading.Event()
        def frame(slot):
            release.wait(timeout=1)
            return base64.b64encode(bytes((slot,0,0))*1152).decode()
        device.frame=frame
        client=client_for('http://localhost:1234')
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None)
        bridge._executor=ThreadPoolExecutor(max_workers=2)
        bridge._client=client; bridge._demand=True
        self.assertTrue(bridge._valid(client,0))
        bridge._submit_frame(device,0,client,0)
        bridge._submit_frame(device,1,client,0)
        # Force completion callbacks in reverse request order in one loop tick.
        futures=list(bridge._pending)
        release.set()
        await asyncio.gather(*futures)
        # Exercise pending-queue ordering separately from already-sent guard.
        bridge._latest=asyncio.Queue(maxsize=1)
        bridge._latest.put_nowait((0,{'sequence':100}))
        bridge._submit_frame(device,0,client,0)
        await asyncio.gather(*list(bridge._pending))
        await self.wait_until(lambda:bridge.diagnostics()['captured']==3)
        self.assertEqual(bridge.diagnostics()['captureErrors'],0)
        _,frame=bridge._latest.get_nowait()
        self.assertEqual(frame['sequence'],100)
        await bridge.aclose()

    async def test_identity_read_reserves_slot_until_worker_exits_after_cancellation(self):
        from concurrent.futures import ThreadPoolExecutor
        started=threading.Event(); release=threading.Event()
        bridge=preview.PreviewBridge('.',{},status_path=None)
        bridge._executor=ThreadPoolExecutor(max_workers=4)
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

    async def test_four_busy_slots_skip_ticks_and_cancellation_discards_all_late_frames(self):
        from concurrent.futures import ThreadPoolExecutor
        class SlowDevice(FakeDevice):
            def frame(self,slot):
                with self.lock:
                    self.calls.append(time.monotonic()); self.active+=1; self.max_active=max(self.max_active,self.active)
                try:
                    time.sleep(.2)
                    return base64.b64encode(bytes((slot,0,0))*1152).decode()
                finally:
                    with self.lock: self.active-=1
        device=SlowDevice(); client=client_for('http://localhost:1234')
        bridge=preview.PreviewBridge('.',{'agent':client},status_path=None,device_factory=lambda _:device)
        bridge._executor=ThreadPoolExecutor(max_workers=4)
        bridge._client=client; bridge._demand=True
        task=asyncio.create_task(bridge._capture(client,DEVICE))
        try:
            await self.wait_until(lambda:bridge.diagnostics()['busySkipped']>1)
            self.assertEqual(device.max_active,4)
            self.assertGreaterEqual(min(b-a for a,b in zip(device.calls,device.calls[1:])),.024)
        finally:
            bridge._invalidate(); task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
            await bridge.aclose()
        self.assertEqual(device.active,0)
        self.assertTrue(bridge._latest.empty())


if __name__=='__main__': unittest.main()
