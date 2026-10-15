"""A display lease in device storage, so several Macs can share one BUSY Bar.

The holder writes its host identifier, level, and expiry time. Other hosts wait
for an unexpired lease unless their item is urgent. An expiry bounds the wait
when a holder stops or loses its connection.
"""
import hashlib
import json
import socket
import time

from .api import APIError

PATH = "/ext/user_assets/ai-status/display-lease.json"
TTL = 20.0
CACHE = 2.0


def host_id():
    return hashlib.sha256(socket.gethostname().encode()).hexdigest()[:12]


class DisplayLease:
    def __init__(self, client, *, host=None, clock=None):
        self.client = client
        self.host = host or host_id()
        self.clock = clock or time.time
        self._cached = None
        self._read_at = -float("inf")
        self.held = False

    def _read(self, *, fresh=False):
        if fresh or self.clock() - self._read_at >= CACHE:
            try:
                data = json.loads(self.client.read_file(PATH))
                self._cached = data if isinstance(data, dict) else None
            except APIError as error:
                # Firmware reports a missing storage file as HTTP 400. Other
                # failures leave ownership unknown and must stop writes/actions.
                if error.http_status not in (400,404):
                    raise
                self._cached = None
            except (ValueError, TypeError, UnicodeError):
                self._cached = None
            self._read_at = self.clock()
        return self._cached

    def foreign(self, *, fresh=False):
        """Return another host's unexpired lease, or None."""
        lease = self._read(fresh=fresh)
        if not lease or lease.get("host") == self.host:
            return None
        until = lease.get("until")
        if type(until) not in (int, float) or until <= self.clock():
            return None
        return lease

    def _write(self, level):
        lease = {"host": self.host, "level": level, "until": self.clock() + TTL}
        self.client.write_file(PATH, json.dumps(lease).encode())
        self._cached, self._read_at = lease, self.clock()

    def acquire(self, level):
        """Urgent items preempt lower levels; equal urgent items wait for release."""
        other = self.foreign(fresh=True)
        if other and (level != "urgent" or other.get('level') == 'urgent'):
            return False
        self._write(level)
        if level != "urgent" and self.foreign(fresh=True):
            return False
        self.held = True
        return True

    def renew(self, level):
        """Keep the lease; return False when another host took it."""
        if self.foreign(fresh=True):
            self.held = False
            return False
        self._write(level)
        return True

    def release(self):
        if not self.held:
            return
        self.held = False
        try:
            lease = self._read(fresh=True)
            if lease and lease.get("host") == self.host:
                self.client.write_file(PATH, json.dumps({"host": self.host, "until": 0}).encode())
                self._cached, self._read_at = None, self.clock()
        except APIError:
            pass
