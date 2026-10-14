import io
import json
import unittest
from urllib.error import HTTPError, URLError

from busybar_status.api import BusyAPI, AuthError, ConnectionError


class Response(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *args): self.close()


class APITests(unittest.TestCase):
    def test_clear_only_owns_its_namespace(self):
        requests = []
        def open_url(req, timeout):
            requests.append(req)
            return Response(b'{"status":"ok"}')
        BusyAPI("private-secret", open_url=open_url).clear()
        self.assertEqual(requests[0].method, "DELETE")
        self.assertEqual(json.loads(requests[0].data), {"application_name": "ai-status"})
        self.assertEqual(requests[0].full_url, "https://api.busy.app/busybar/display/draw")

    def test_focus_conflict_suppresses_display_update(self):
        def open_url(req, timeout):
            raise HTTPError(req.full_url, 409, "Conflict", {}, None)
        self.assertFalse(BusyAPI("secret", open_url=open_url).draw({"elements": []}))

    def test_identifies_the_app_instead_of_blocked_default_urllib_agent(self):
        seen=[]
        def open_url(req, timeout):
            seen.append(req.get_header("User-agent"))
            return Response(b'{}')
        BusyAPI("secret", open_url=open_url).status()
        self.assertEqual(seen, ["busy-bar-status/0.1"])

    def test_auth_errors_do_not_echo_response_or_token(self):
        def open_url(req, timeout):
            raise HTTPError(req.full_url, 403, "private-secret", {},
                            io.BytesIO(b'private-secret'))
        with self.assertRaises(AuthError) as caught:
            BusyAPI("private-secret", open_url=open_url).status()
        self.assertNotIn("private-secret", str(caught.exception))

    def test_network_errors_are_sanitized(self):
        def open_url(req, timeout): raise URLError("private-secret")
        with self.assertRaises(ConnectionError) as caught:
            BusyAPI("private-secret", open_url=open_url).status()
        self.assertNotIn("private-secret", str(caught.exception))

    def test_redirect_cannot_forward_credentials(self):
        from busybar_status.api import NoRedirect
        from urllib.request import Request
        self.assertIsNone(NoRedirect().redirect_request(
            Request("https://api.busy.app/busybar/status"), None, 302,
            "Found", {}, "https://example.com"))


if __name__ == "__main__":
    unittest.main()
