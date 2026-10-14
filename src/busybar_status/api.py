"""Small authenticated BUSY API client; never expose response bodies on errors."""
import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

BASE_URL = "https://api.busy.app/busybar"
APP_NAME = "ai-status"


class APIError(RuntimeError):
    pass


class AuthError(APIError):
    pass


class ConnectionError(APIError):
    pass


class ConflictError(APIError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class BusyAPI:
    def __init__(self, token, *, open_url=None):
        if not token or any(c.isspace() for c in token):
            raise AuthError("A valid BUSY Bar token is required.")
        self._token = token
        self._open = open_url or build_opener(NoRedirect()).open
        self._thinking_kind = None

    def request(self, path, method="GET", payload=None, *, raw=False):
        if not path.startswith("/") or ".." in path or ":" in path:
            raise ValueError("Invalid device API path")
        headers = {"Authorization": "Bearer " + self._token, "Accept": "application/json",
                   "User-Agent": "busy-bar-status/0.1"}
        body = None
        if payload is not None:
            if isinstance(payload, bytes):
                body = payload
                headers["Content-Type"] = "application/octet-stream"
            else:
                body = json.dumps(payload, ensure_ascii=True).encode()
                headers["Content-Type"] = "application/json"
        req = Request(BASE_URL + path, data=body, headers=headers, method=method)
        try:
            with self._open(req, timeout=10) as response:
                data = response.read(1_048_577)
            if len(data) > 1_048_576:
                raise APIError("Device response exceeded the size limit.")
            return data if raw else json.loads(data)
        except HTTPError as error:
            code = error.code
            error.close()
            if code in (401, 403):
                raise AuthError("BUSY token rejected; check its device scope or expiry.") from None
            if code == 409:
                raise ConflictError("Display owned by a higher priority application.") from None
            raise APIError(f"BUSY request failed (HTTP {code}).") from None
        except (URLError, TimeoutError, OSError):
            raise ConnectionError("BUSY cloud or device is unavailable.") from None
        except (ValueError, UnicodeError):
            raise APIError("Device returned an invalid response.") from None

    def status(self):
        return self.request("/status")

    def draw(self, payload):
        thinking = next((e for e in payload.get("elements", []) if e.get("id") == "thinking"), None)
        try:
            # Firmware 1.2.4 cannot change an existing widget's element type in
            # place. Reset our own namespace on first use and type transitions;
            # same-type refreshes keep the running animation intact.
            if thinking and thinking["type"] != self._thinking_kind:
                self.clear()
            self.request("/display/draw", "POST", payload)
            if thinking: self._thinking_kind = thinking["type"]
            return True
        except ConflictError:
            return False

    def clear(self):
        result = self.request("/display/draw", "DELETE", {"application_name": APP_NAME})
        self._thinking_kind = None
        return result

    def frame(self, display=0):
        return self.request(f"/screen?display={display}", raw=True)

    def upload_asset(self, filename, data):
        if not re.fullmatch(r"[a-zA-Z0-9._-]+", filename):
            raise ValueError("Invalid asset filename.")
        query = urlencode({"application_name": APP_NAME, "file": filename})
        return self.request("/assets/upload?"+query, "POST", data)
