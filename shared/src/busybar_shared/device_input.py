"""Actual device input via local WebSocket and the official BUSY protobuf schema."""
import asyncio
import ipaddress
import json
import math
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit, urlencode

from busylib.state_stream_proto import state_pb2,input_pb2
from google.protobuf.message import DecodeError
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus, WebSocketException
from .api import AuthError
from .credentials import read_input_token

MAX_FRAME = 262144


def start_pressed(raw):
    if not isinstance(raw,bytes) or len(raw)>MAX_FRAME:
        raise ValueError('Invalid input frame')
    state = state_pb2.State()
    try:
        state.ParseFromString(raw)
    except DecodeError:
        raise ValueError('Invalid input frame') from None
    for update in state.updates:
        if update.WhichOneof('state')!='input' or update.input.WhichOneof('event')!='button_event':
            continue
        button=update.input.button_event
        if button.button==input_pb2.START and button.action==input_pb2.PRESS:
            return True
    return False


def read_input_status(path, *, now=None):
    unavailable={'connected':False,'error':'not_connected'}
    try:
        with Path(path).open() as stream:
            data=json.loads(stream.read(4097))
        stamp=data.get('timestamp')
        age=(time.time() if now is None else now)-stamp
        if type(stamp) not in (int,float) or not math.isfinite(age) or not 0<=age<=30:
            return unavailable
        error=data.get('error')
        if error not in ('', 'unavailable','auth','protocol'):
            return unavailable
        transport=data.get('transport','usb')
        if transport not in ('usb','wifi'):
            return unavailable
        return {'connected':data.get('connected') is True,'error':error,'transport':transport}
    except (OSError,ValueError,TypeError,AttributeError):
        return unavailable


class InputMonitor:
    def __init__(self, *, addr='10.0.4.20', token=None, enabled=True,
                 transport='usb', error='unavailable'):
        parsed=urlsplit('//'+addr)
        if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise ValueError('Input address must be a local IP address')
        host=parsed.hostname or ''
        if not ipaddress.ip_address(host).is_private:
            raise ValueError('Input address must be a local IP address')
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError('Invalid local input port')
        self.enabled=enabled
        self.transport=transport
        self._url='ws://'+addr+'/api/status/ws'
        if token:
            self._url+='?'+urlencode({'x-api-token':token})
        self._connected=False
        self._error=error
        self._pressed=threading.Event()
        self._pressed_lock=threading.Lock()
        self._stopping=threading.Event()
        self._thread=None
        self._loop=None
        self._task=None

    @property
    def connected(self): return self._connected

    def start(self):
        if not self.enabled: return
        self._thread=threading.Thread(target=self._run,name='busy-bar-input',daemon=True)
        self._thread.start()

    def _run(self):
        async def main():
            self._loop=asyncio.get_running_loop()
            self._task=asyncio.current_task()
            backoff=2
            while not self._stopping.is_set():
                try:
                    async with connect(self._url, proxy=None, open_timeout=2, close_timeout=1,
                                       max_size=MAX_FRAME,ping_interval=10,ping_timeout=10) as ws:
                        await ws.send('{"enable":true}')
                        # A valid protobuf frame, rather than a TCP connection,
                        # establishes that this is the real device state stream.
                        raw=await asyncio.wait_for(ws.recv(),timeout=5)
                        while True:
                            if isinstance(raw,bytes):
                                pressed=start_pressed(raw)
                                self._connected=True
                                self._error=''
                                backoff=2
                                if pressed:
                                    with self._pressed_lock:
                                        self._pressed.set()
                            raw=await ws.recv()
                except InvalidStatus as error:
                    if error.response.status_code in (401,403):
                        self._error='auth'
                        self._connected=False
                        return  # Never retry rejected local credentials.
                    self._error='unavailable'
                except ValueError:
                    self._error='protocol'
                except (OSError,TimeoutError,WebSocketException):
                    self._error='unavailable'
                finally:
                    self._connected=False
                await asyncio.sleep(backoff)
                backoff=min(backoff*2,30)
        try:
            asyncio.run(main())
        except asyncio.CancelledError:
            pass
        finally:
            self._connected=False
            self._loop=None

    def pop_start_pressed(self):
        with self._pressed_lock:
            pressed=self._pressed.is_set()
            self._pressed.clear()
            return pressed

    def write_status(self,path):
        try:
            path=Path(path)
            path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            with tempfile.NamedTemporaryFile(mode='w',dir=path.parent,delete=False) as stream:
                temp=Path(stream.name)
                try:
                    json.dump({'connected':self.connected,'error':self._error,
                               'transport':self.transport,'timestamp':time.time()},stream)
                    stream.flush()
                    temp.replace(path)
                finally:
                    temp.unlink(missing_ok=True)
        except OSError:
            # Optional diagnostics must never block socket/display cleanup.
            pass

    def stop(self):
        self._stopping.set()
        loop=self._loop
        if loop and self._task:
            try: loop.call_soon_threadsafe(self._task.cancel)
            except RuntimeError: pass
        if self._thread: self._thread.join(timeout=3)

    def is_alive(self):
        return self._thread is not None and self._thread.is_alive()


def configured_input_monitor(runtime):
    """Use explicit private Wi-Fi configuration, otherwise retain USB input."""
    try:
        with (Path(runtime)/'input.json').open() as stream:
            raw=stream.read(4097)
        if len(raw)>4096:
            raise ValueError('Input configuration is too large')
        config=json.loads(raw)
        if (not isinstance(config,dict) or 'addr' not in config
                or set(config)-{'addr','device_id'}
                or not isinstance(config['addr'],str)
                or ('device_id' in config and not isinstance(config['device_id'],str))):
            raise ValueError('Invalid input configuration')
        # Validate the address before attempting any Keychain operation.
        monitor=InputMonitor(addr=config['addr'],transport='wifi')
    except FileNotFoundError:
        return InputMonitor()
    except (OSError,ValueError,TypeError,RecursionError):
        return InputMonitor(enabled=False,transport='wifi',error='protocol')
    try:
        token=read_input_token()
    except AuthError:
        return InputMonitor(enabled=False,transport='wifi',error='auth')
    return InputMonitor(addr=config['addr'],token=token,transport=monitor.transport)
