"""Read the Mac's default-interface byte rates without generating network traffic."""
from dataclasses import dataclass
import re
import subprocess
import time


@dataclass(frozen=True)
class NetworkRates:
    upload: float
    download: float
    interface: str


def parse_counters(text, interface):
    for line in text.splitlines():
        fields = line.split()
        # IPv4/IPv6 lines repeat these counters. Link rows have an optional
        # Address field (absent on utun), so index byte totals from the right.
        if len(fields) >= 10 and fields[0] == interface and fields[2].startswith('<Link#'):
            return interface, int(fields[-5]), int(fields[-2])
    raise ValueError('No link counters for the default interface.')


def read_counters():
    def run(args):
        return subprocess.run(args, check=True, capture_output=True, text=True,
                              timeout=2).stdout
    route = run(['/sbin/route', '-n', 'get', 'default'])
    match = re.search(r'^\s*interface:\s*([a-z][a-z0-9]{0,15})\s*$', route, re.MULTILINE)
    if not match:
        raise ValueError('Default interface unavailable.')
    interface = match.group(1)
    return parse_counters(run(['/usr/sbin/netstat', '-ibn', '-I', interface]), interface)


class NetworkSampler:
    def __init__(self, *, reader=read_counters, clock=time.monotonic):
        self._reader = reader
        self._clock = clock
        self._previous = None

    def sample(self):
        now = self._clock()
        try:
            current = self._reader()
        except (OSError, ValueError, subprocess.SubprocessError):
            self._previous = None
            return None
        previous = self._previous
        self._previous = (now, current)
        if previous is None:
            return None
        old_time, old = previous
        elapsed = now - old_time
        if current[0] != old[0] or elapsed <= 0:
            return None
        received, sent = current[1] - old[1], current[2] - old[2]
        if min(received, sent) < 0:
            return None
        return NetworkRates(sent / elapsed, received / elapsed, current[0])


def compact_rate(value):
    if value is None:
        return '--'
    value = max(0, value)
    for unit in 'BKMG':
        if value < 999.5 or unit == 'G':
            value = min(value, 999)
            if unit == 'B':
                return f'{value:.0f}B'
            return (f'{value:.1f}' if value < 9.95 else f'{value:.0f}') + unit
        value /= 1024
