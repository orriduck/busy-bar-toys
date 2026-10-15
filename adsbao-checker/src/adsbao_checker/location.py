"""Validated private Core Location snapshots and a single managed native helper.

No function prints coordinates or falls back to network location providers.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import stat
import subprocess
import sys
import threading
import time

LOCATION_RUNTIME_DIR = Path.home() / 'Library/Application Support/BusyBarAI'
DEFAULT_LOCATION_PATH = LOCATION_RUNTIME_DIR / 'location.json'
MAX_FIX_AGE_SECONDS = 300.0
MAX_ACCURACY_METRES = 500.0
_STATUSES = frozenset({'denied', 'restricted', 'not_determined', 'services_disabled',
                       'unavailable', 'acquiring', 'timeout'})


@dataclass(frozen=True)
class LocationFix:
    latitude: float
    longitude: float
    accuracy: float
    timestamp: float


def _number(value: object) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _read_payload(path: Path) -> tuple[dict | None, str]:
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        details = os.fstat(fd)
        if not stat.S_ISREG(details.st_mode) or details.st_size > 16_384:
            return None, 'invalid'
        with os.fdopen(fd, 'r', encoding='utf-8') as source:
            fd = None
            payload = json.loads(source.read(16_385))
        return (payload, 'ok') if isinstance(payload, dict) else (None, 'invalid')
    except FileNotFoundError:
        return None, 'missing'
    except (OSError, UnicodeError, ValueError, RecursionError):
        return None, 'invalid'
    finally:
        if fd is not None:
            os.close(fd)


def _validate(payload: dict, now: float) -> str:
    status = payload.get('status')
    if status != 'ok':
        return status if isinstance(status, str) and status in _STATUSES else 'unavailable'
    if not _number(now):
        return 'invalid'
    fields = [payload.get(key) for key in ('latitude', 'longitude', 'accuracy', 'timestamp')]
    if not all(_number(value) for value in fields):
        return 'invalid'
    latitude, longitude, accuracy, timestamp = fields
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180 or accuracy < 0:
        return 'invalid'
    if timestamp > now:
        return 'invalid'
    if now - timestamp > MAX_FIX_AGE_SECONDS:
        return 'stale'
    if accuracy > MAX_ACCURACY_METRES:
        return 'poor_accuracy'
    return 'ok'


def read_location(path: Path = DEFAULT_LOCATION_PATH, now: float | None = None) -> LocationFix | None:
    """Return only a finite, recent, sufficiently accurate authorized fix."""
    payload, _ = _read_payload(Path(path))
    if payload is None or _validate(payload, time.time() if now is None else now) != 'ok':
        return None
    return LocationFix(*(float(payload[key]) for key in ('latitude', 'longitude', 'accuracy', 'timestamp')))


def location_status(path: Path = DEFAULT_LOCATION_PATH, now: float | None = None) -> dict:
    """Allowlisted status and quality metadata suitable for terminal diagnostics."""
    payload, status = _read_payload(Path(path))
    if payload is None:
        return {'status': status}
    now = time.time() if now is None else now
    status = _validate(payload, now)
    if status == 'ok':
        return {'status': 'ok', 'age_seconds': float(now - payload['timestamp']),
                'accuracy_m': float(payload['accuracy'])}
    return {'status': status}


@dataclass
class _HelperHandle:
    process: subprocess.Popen
    request_authorization: bool
    stopped: bool = False


_helper: _HelperHandle | None = None
_helper_lock = threading.RLock()


def start_location_helper(repo: Path, runtime: Path = LOCATION_RUNTIME_DIR, *,
                          request_authorization: bool = False) -> _HelperHandle | None:
    """Start the bundled helper; only explicit setup may request native permission.

    Building is a separate install step. Normal watch never builds or asks for
    authorization. The native helper also uses a private process singleton lock.
    """
    global _helper
    if sys.platform != 'darwin':
        return None
    executable = Path(repo) / '.venv/BusyBarLocation.app/Contents/MacOS/BusyBarLocation'
    with _helper_lock:
        if _helper is not None and not _helper.stopped and _helper.process.poll() is None:
            if not request_authorization or _helper.request_authorization:
                return _helper
            stop_location_helper(_helper)
        if not executable.is_file() or not os.access(executable, os.X_OK):
            return None
        try:
            runtime = Path(runtime)
            runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
            if runtime.is_symlink() or runtime.stat().st_uid != os.getuid():
                return None
            runtime.chmod(0o700)
            command = [str(executable), '--runtime', str(runtime)]
            if request_authorization:
                command.append('--request-authorization')
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       close_fds=True)
        except OSError:
            return None
        _helper = _HelperHandle(process, request_authorization)
        return _helper


def stop_location_helper(handle: _HelperHandle | None) -> None:
    """Stop and reap only the process started by this Python caller."""
    global _helper
    with _helper_lock:
        if handle is None or handle.stopped:
            return
        handle.stopped = True
        if handle.process.poll() is None:
            try:
                handle.process.terminate()
            except ProcessLookupError:
                pass
            try:
                handle.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    handle.process.kill()
                except ProcessLookupError:
                    pass
                handle.process.wait(timeout=5)
        else:
            handle.process.wait(timeout=5)
        if _helper is handle:
            _helper = None
