import io
import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import unittest
from adsbao_checker.traffic import parse_envelope, sse_events, coordinate_channel, TrafficMonitor
from test_proximity import envelope


class TrafficTests(unittest.TestCase):
    def test_newer_stale_signal_cannot_be_revived_by_older_valid_frame(self):
        now=1000
        class Response:
            headers={'Content-Type':'text/event-stream'}
            def raise_for_status(self):pass
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
            async def aiter_bytes(self,**kwargs):
                for sequence,stale in ((3,False),(5,True),(4,False)):
                    data=envelope(now=now);data.update(sequence=sequence,stale=stale)
                    yield ('event: nearby:traffic\ndata: '+json.dumps(data)+'\n\n').encode()
        class Client:
            def stream(self,*args,**kwargs):return Response()
        monitor=TrafficMonitor(clock=lambda:now)
        monitor.update_location(type('Fix',(),{'latitude':0,'longitude':0})())
        asyncio.run(monitor._read(Client(),'nearby:0.00:0.00'))
        self.assertIsNone(monitor.latest())
        self.assertEqual(monitor.status()['error'],'stale_or_pending')

    def test_actual_envelope_shape_and_identity(self):
        frame=parse_envelope(envelope(),now=1000)
        self.assertEqual(frame.aircraft[0].identity,'TEST123')
        self.assertEqual(frame.channel,'nearby:0.00:0.00')
        self.assertEqual(coordinate_channel(42.364,-71.014),'nearby:42.36:-71.01')

    def test_stale_ground_invalid_and_old_positions_do_not_alert(self):
        for change in ({'fixAt':939},{'lat':True},{'lon':181},{'alt_baro':'ground'}, {'on_ground':True}):
            with self.subTest(change=change):
                self.assertEqual(parse_envelope(envelope(**change),now=1000).aircraft,())
        for change in ({'stale':True},{'emittedAt':939},{'fetchedAt':939}):
            payload=envelope();payload.update(change)
            self.assertIsNone(parse_envelope(payload,now=1000))

    def test_empty_traffic_is_valid_but_pending_context_is_not(self):
        payload=envelope();payload['data']['aircraft']['ac']=[]
        self.assertEqual(parse_envelope(payload,now=1000).aircraft,())
        payload['data']['aircraft']=None
        self.assertIsNone(parse_envelope(payload,now=1000))

    def test_bounded_sse_parser_handles_heartbeat_multiline_and_eof(self):
        stream=io.BytesIO(b':heartbeat\r\nevent: nearby:traffic\r\ndata: {"a":\r\ndata: 1}\r\n\r\n')
        self.assertEqual(list(sse_events(stream)),[('nearby:traffic','{"a":\n1}')])
        with self.assertRaises(ValueError):list(sse_events(io.BytesIO(b'data: '+b'x'*300000+b'\n')))

    def test_real_stream_ignores_old_sequence_and_stops_during_silent_read(self):
        release=threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
                for seq in (3,2):
                    payload=envelope(now=time.time());payload['sequence']=seq
                    if seq==2:payload['stale']=True
                    self.wfile.write(('event: nearby:traffic\ndata: '+json.dumps(payload)+'\n\n').encode())
                self.wfile.flush();release.wait(5)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        monitor=TrafficMonitor(origin=f'http://127.0.0.1:{server.server_port}')
        monitor.update_location(type('Fix',(),{'latitude':0,'longitude':0})())
        try:
            monitor.start();deadline=time.monotonic()+3
            while not monitor.latest() and time.monotonic()<deadline:time.sleep(.01)
            self.assertIsNotNone(monitor.latest())
            self.assertEqual(monitor.latest().sequence,3)
            began=time.monotonic();monitor.stop()
            self.assertLess(time.monotonic()-began,1)
            self.assertFalse(monitor._thread.is_alive())
        finally:
            monitor.stop();release.set();server.shutdown();server.server_close()
