"""Real loopback HTTP boundary, without device endpoints or Keychain prompts."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time
import json
import tempfile
from unittest.mock import Mock, MagicMock
from http.client import IncompleteRead
from busybar_shared.cloud import Producer
import unittest
from busybar_shared.cloud import Transport, CloudError

class CloudHTTPTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.headers=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                cls.headers.append(dict(self.headers))
                if self.path in ('/api/stalled','/api/events'):
                    self.send_response(200); self.send_header('Content-Length','100'); self.end_headers()
                    self.wfile.write(b'{'); self.wfile.flush(); time.sleep(.2); return
                if self.path=='/api/truncated':
                    self.send_response(200); self.send_header('Content-Length','100'); self.end_headers()
                    self.wfile.write(b'{"protocol":1}'); return
                if self.path=='/api/asset-miss':
                    self.send_response(403); self.end_headers(); self.wfile.write(b'{"error":"ASSET_NOT_AUTHORIZED"}'); return
                if self.path=='/api/input':
                    self.send_response(403); self.end_headers(); self.wfile.write(b'{"error":"FORBIDDEN"}'); return
                if self.path=='/api/redirect':
                    self.send_response(302); self.send_header('Location','/api/forbidden'); self.end_headers(); return
                if self.path=='/api/error':
                    self.send_response(401); self.end_headers(); self.wfile.write(b'private server body'); return
                self.send_response(200); self.end_headers()
                self.wfile.write(b'{"protocol":1}')
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True); cls.thread.start()
    @classmethod
    def tearDownClass(cls): cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
    def test_bearer_only_and_no_redirect(self):
        http=Transport('http://127.0.0.1:'+str(self.server.server_port),'test-publisher')
        self.assertEqual(http.request('GET','/api/snapshot'),{'protocol':1})
        self.assertEqual(self.headers[-1]['Authorization'],'Bearer test-publisher')
        self.assertNotIn('Cookie',self.headers[-1])
        before=len(self.headers)
        with self.assertRaises(CloudError): http.request('GET','/api/redirect')
        self.assertEqual(len(self.headers),before+1)
        with self.assertRaises(CloudError) as error: http.request('GET','/api/error')
        self.assertEqual(error.exception.status,401)
        self.assertNotIn('private',str(error.exception))

    def test_stalled_and_truncated_success_bodies_are_sanitized_failures(self):
        http=Transport('http://127.0.0.1:'+str(self.server.server_port),'test-publisher',timeout=.05)
        for path in ('/api/stalled','/api/truncated'):
            with self.subTest(path=path), self.assertRaises(CloudError): http.request('GET',path)
        with self.assertRaises(CloudError): next(http.events())

    def test_asset_miss_and_input_grant_denial_are_distinct_from_credentials(self):
        http=Transport('http://127.0.0.1:'+str(self.server.server_port),'test-publisher')
        with self.assertRaises(CloudError) as asset: http.request('GET','/api/asset-miss')
        self.assertEqual(asset.exception.code,'asset_not_authorized')
        with self.assertRaises(CloudError) as input_error: http.request('GET','/api/input')
        self.assertEqual(input_error.exception.code,'input_forbidden')

    def test_partial_read_http_exception_is_normalized(self):
        opener=MagicMock(); response=opener.open.return_value.__enter__.return_value
        response.read.side_effect=IncompleteRead(b'private partial body',100)
        http=Transport('http://localhost:8787','test-publisher',opener=opener)
        with self.assertRaises(CloudError) as error: http.request('GET','/api/snapshot')
        self.assertNotIn('private',str(error.exception))

    def test_publisher_retries_after_real_stalled_snapshot_body(self):
        published=threading.Event(); attempts=[0]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                attempts[0]+=1
                self.send_response(200)
                if attempts[0]==1:
                    self.send_header('Content-Length','100'); self.end_headers()
                    self.wfile.write(b'{'); self.wfile.flush(); time.sleep(.2); return
                self.end_headers(); self.wfile.write(b'{"protocol":1,"revision":1,"services":[{"id":"a"}],"items":[]}')
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length','0')))
                self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
                if self.path=='/api/publish': published.set()
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        with tempfile.TemporaryDirectory() as directory:
            http=Transport('http://127.0.0.1:'+str(server.server_port),'test-publisher',timeout=.05)
            producer=Producer(directory,{'role':'agent','serviceId':'a','instanceId':'m','epoch':'e'},http,clock=lambda:100)
            producer.state.recognize('a',kind='agent',level='info',title='A',detail='',scene={'entryDurationMs':0,'commands':[{'offsetMs':0,'elements':[]}]})
            worker=threading.Thread(target=producer._run,daemon=True); worker.start()
            try:
                self.assertTrue(published.wait(2.5),'publisher must retry after a body timeout')
                self.assertTrue(worker.is_alive())
                self.assertGreaterEqual(attempts[0],2)
            finally:
                producer.stop(); worker.join(1); server.shutdown(); server.server_close(); thread.join()
