"""Real loopback HTTP boundary, without device endpoints or Keychain prompts."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
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
