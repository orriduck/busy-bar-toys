"""Optional read-only LAN framebuffer bridge. Credentials and pixels stay transient.

Cloud socket supervision, capture scheduling, and local HTTP reads run separately
from the collector, publisher, input monitor, actions, and urgent watchdog.
"""
import asyncio
import base64
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import hashlib
from http.client import HTTPConnection, HTTPException, HTTPResponse
import ipaddress
import io
import json
import logging
from pathlib import Path
import re
import threading
import time
from urllib.parse import urlsplit

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus, WebSocketException

from .api import AuthError
from .cloud import atomic_json, CloudError
from .credentials import read_input_token
from .frames import decode_frame

FRAME_BYTES = 3456
MAX_MESSAGE = 6143
READ_TIMEOUT = .3
FPS = 2
MAX_IN_FLIGHT = 1
_HEX = re.compile(r'^[a-f0-9]{64}$')
_STREAM = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
# A fresh authenticated socket resets frame sequence and discards stale work.
_TRANSIENT_CLOUD_ERRORS = frozenset(('PREVIEW_STALE_FRAME','PREVIEW_RATE_LIMIT','PREVIEW_SEQUENCE'))
_DIAGNOSTIC_PEER_CODES = _TRANSIENT_CLOUD_ERRORS | frozenset((
    'PREVIEW_PUBLISHER_IDLE','PREVIEW_DISCONNECTED','PREVIEW_CAPABILITY_REQUIRED','PREVIEW_AUTH_REVOKED',
    'UNAUTHORIZED','EPOCH_EXPIRED','INVALID_PREVIEW_FRAME','PREVIEW_FRAME_SIZE',
))
_DIAGNOSTIC_CODES = _DIAGNOSTIC_PEER_CODES | frozenset((
    'session_ended','normal_close','no_close_frame','websocket_closed','websocket_error','ping_timeout',
    'PREVIEW_PUBLISHER_EXISTS','handshake_rejected','transport_error','transport_timeout','cancelled','stopped','unexpected_error','unknown',
    'auth','body','device_mismatch','frame','identity','invalid_config','not_found','protocol',
    'redirect_refused','timeout','unavailable',
))
_QUIET = logging.Logger('busy-preview-private')
_QUIET.disabled = True


class PreviewError(RuntimeError):
    """Fixed codes only: never include peer bodies, addresses, or credentials."""
    def __init__(self, code='unavailable'):
        self.code = code
        super().__init__('Preview: ' + code)


def private_address(addr):
    try:
        if not isinstance(addr,str) or not addr or any(c.isspace() for c in addr): raise ValueError()
        pattern=r'\[[0-9A-Fa-f:]+\](?::[0-9]{1,5})?' if addr.startswith('[') else r'(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]{1,5})?'
        if not re.fullmatch(pattern,addr): raise ValueError()
        parsed=urlsplit('//'+addr)
        if parsed.username is not None or parsed.password is not None or parsed.path or parsed.query or parsed.fragment:
            raise ValueError()
        ip=ipaddress.ip_address(parsed.hostname or '')
        # Explicit RFC1918 / ULA only; no DNS, loopback, metadata/link-local,
        # multicast, unspecified, or IPv4-mapped alias to another network.
        networks=('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16') if ip.version==4 else ('fc00::/7',)
        if not any(ip in ipaddress.ip_network(net) for net in networks): raise ValueError()
        port=parsed.port if parsed.port is not None else 80
        if not 1<=port<=65535: raise ValueError()
        return str(ip),port
    except (ValueError,TypeError):
        raise PreviewError('invalid_config') from None


def parse_demand(raw,device_id):
    try:
        if not isinstance(raw,str) or len(raw.encode('utf-8'))>MAX_MESSAGE: raise ValueError()
        value=json.loads(raw)
        if (not isinstance(value,dict) or set(value)!={'type','enabled','targetFps','streamId','deviceId'}
                or value['type']!='demand' or type(value['enabled']) is not bool
                or type(value['targetFps']) is not int or value['targetFps'] not in (2,30)
                or not isinstance(value['streamId'],str) or not _STREAM.fullmatch(value['streamId'])
                or not isinstance(device_id,str) or not _HEX.fullmatch(device_id)
                or value['deviceId']!=device_id): raise ValueError()
        return value
    except (ValueError,UnicodeError,TypeError,RecursionError):
        raise PreviewError('protocol') from None


def rgb_pixels(raw):
    try:
        # Firmware sends 4608 base64 bytes, sometimes as a JSON string.
        if not isinstance(raw,bytes) or len(raw) not in (4608,4610): raise ValueError()
        encoded=raw[1:-1] if len(raw)==4610 and raw.startswith(b'\"') and raw.endswith(b'\"') else raw
        if len(encoded)!=4608 or not re.fullmatch(rb'[A-Za-z0-9+/]{4608}',encoded): raise ValueError()
        image=decode_frame(encoded,0)
        return base64.b64encode(image.tobytes()).decode('ascii')
    except (ValueError,TypeError,UnicodeError):
        raise PreviewError('frame') from None


class _DeadlineReader(io.RawIOBase):
    def __init__(self,sock,deadline,limit):
        super().__init__()
        self.sock=sock; self.deadline=deadline; self.remaining=limit
        # Keep socket.makefile's reference-counted ownership: http.client may
        # close its connection before reading a Connection: close response.
        self._file=sock.makefile('rb',buffering=0)

    def readable(self): return True

    def readinto(self,buffer):
        remaining=self.deadline-time.monotonic()
        if remaining<=0: raise PreviewError('timeout')
        if self.remaining<=0: raise PreviewError('body')
        self.sock.settimeout(remaining)
        size=self._file.readinto(memoryview(buffer)[:min(len(buffer),self.remaining)])
        self.remaining-=size
        return size

    def close(self):
        try: self._file.close()
        finally: super().close()


class _DeadlineSocket:
    def __init__(self,sock,deadline,limit):
        self.sock=sock; self.deadline=deadline; self.limit=limit

    def makefile(self,*args,**kwargs):
        return io.BufferedReader(_DeadlineReader(self.sock,self.deadline,self.limit))


class LocalDevice:
    """One exclusive HTTP slot; bounded reads yield device capacity to display writes."""
    def __init__(self,addr,token):
        self._host,self._port=private_address(addr)
        if not isinstance(token,str) or not token or any(c.isspace() for c in token):
            raise PreviewError('auth')
        self._token=token
        self._connections=[None]*MAX_IN_FLIGHT

    def _get(self,slot,path,limit):
        if slot not in range(MAX_IN_FLIGHT) or path not in ('/api/status','/api/status/device','/api/screen?display=0'):
            raise PreviewError('protocol')
        deadline=time.monotonic()+READ_TIMEOUT
        connection=self._connections[slot]
        try:
            if connection is None:
                connection=HTTPConnection(self._host,self._port,timeout=READ_TIMEOUT)
                self._connections[slot]=connection
            connection.set_debuglevel(0)  # Never inherit process-wide header logging.
            connection.timeout=READ_TIMEOUT
            if connection.sock: connection.sock.settimeout(READ_TIMEOUT)
            connection.response_class=lambda sock,**kwargs:HTTPResponse(
                _DeadlineSocket(sock,deadline,65536+limit+1),**kwargs)
            connection.request('GET',path,headers={'x-api-token':self._token,'Accept':'application/json'})
            response=connection.getresponse()
            if response.status in (401,403): raise PreviewError('auth')
            if 300<=response.status<400: raise PreviewError('redirect_refused')
            if response.status!=200: raise PreviewError('not_found' if response.status==404 else 'unavailable')
            length=response.getheader('Content-Length')
            if length is not None: length=length.strip(' \t')
            if length is not None and (not length.isdigit() or int(length)>limit): raise PreviewError('body')
            chunks=[]; size=0
            while True:
                remaining=deadline-time.monotonic()
                if remaining<=0: raise PreviewError('timeout')
                if connection.sock: connection.sock.settimeout(remaining)
                chunk=response.read1(min(2048,limit+1-size))
                if not chunk: break
                chunks.append(chunk); size+=len(chunk)
                if size>limit: raise PreviewError('body')
            if length is not None and int(length)!=size: raise PreviewError('body')
            response.close()
            return b''.join(chunks)
        except PreviewError:
            if connection: connection.close()
            self._connections[slot]=None
            raise
        except (OSError,HTTPException,ValueError):
            if connection: connection.close()
            self._connections[slot]=None
            raise PreviewError('unavailable') from None

    def verify(self,device_id):
        try:
            try: raw=self._get(0,'/api/status',65536)
            except PreviewError as error:
                if error.code!='not_found': raise
                raw=self._get(0,'/api/status/device',65536)
            value=json.loads(raw)
            device=value.get('device',value) if isinstance(value,dict) else {}
            serial=device.get('serial_number') if isinstance(device,dict) else None
            if not isinstance(serial,str) or not 1<=len(serial)<=256: raise ValueError()
            if hashlib.sha256(serial.encode('utf-8')).hexdigest()!=device_id:
                raise PreviewError('device_mismatch')
        except (ValueError,UnicodeError,TypeError,RecursionError):
            raise PreviewError('identity') from None

    def frame(self,slot):
        return rgb_pixels(self._get(slot,'/api/screen?display=0',4610))

    def close(self):
        for connection in self._connections:
            if connection: connection.close()
        self._connections=[None]*MAX_IN_FLIGHT


def local_device(runtime):
    try:
        with (Path(runtime)/'input.json').open('rb') as stream: raw=stream.read(4097)
        if len(raw)>4096: raise ValueError()
        config=json.loads(raw)
        if (not isinstance(config,dict) or not isinstance(config.get('addr'),str)
                or set(config)-{'addr','device_id'}
                or 'device_id' in config and not isinstance(config['device_id'],str)): raise ValueError()
        private_address(config['addr'])
    except (OSError,ValueError,UnicodeError,TypeError,RecursionError):
        raise PreviewError('invalid_config') from None
    try: return LocalDevice(config['addr'],read_input_token())
    except AuthError: raise PreviewError('auth') from None


class NoRedirectConnect(connect):
    def process_redirect(self,exc):
        return exc


class PreviewBridge:
    """One optional supervisor for all local roles; agent wins when eligible."""
    def __init__(self,runtime,clients,*,device_factory=local_device,status_path=True):
        self.runtime=Path(runtime)
        self.clients=[]
        for key,client in sorted(clients.items(),key=lambda pair:(pair[1].config.get('template',pair[1].config.get('role'))!='agent',pair[0])):
            if client not in self.clients: self.clients.append(client)
        self.device_factory=device_factory
        self.status_path=self.runtime/'preview-status.json' if status_path is True else status_path
        self._stop=threading.Event(); self._thread=None; self._loop=None; self._task=None
        self._executor=None; self._pending=set(); self._busy=[False]*MAX_IN_FLIGHT; self._devices=[]; self._device_future=None
        self._blocked={}; self._generation=0; self._demand=False; self._client=None
        self._capture_error=None; self._active_send=None
        self._last_capture_started=-float('inf')
        self._capture_failures=0; self._capture_retry_at=0
        self._latest=asyncio.Queue(maxsize=1); self._sequence=0; self._last_sent=0
        self._diag_lock=threading.Lock(); self._started=time.monotonic()
        self._session_ends=deque(maxlen=16)
        self._capture_error_events=deque(maxlen=8)
        self._diag={'status':'idle','connected':False,'demand':False,'captureRequested':0,
                    'captured':0,'sent':0,'dropped':0,'busySkipped':0,'captureErrors':0,
                    'invalidatedDropped':0,'outOfOrderDropped':0,'supersededDropped':0,'noDemandDropped':0,
                    'rateLimitedSkipped':0,'displayPausedDropped':0,
                    'targetFps':FPS,'actualTargetFps':FPS,'maxInFlight':MAX_IN_FLIGHT,'pausedForDisplay':False,
                    'captureRetries':0,'connections':0,'disconnects':0,'lastCaptureError':None,'lastCloudError':None,
                    'lastConnectedAtMs':None,'firstFrameSentAtMs':None,'lastFrameSentAtMs':None,
                    'nextRetryDelayMs':None,'lastConnectFailure':None}

    def _update(self,**values):
        with self._diag_lock: self._diag.update(values)

    def _count(self,key):
        with self._diag_lock: self._diag[key]+=1

    def _drop(self,reason):
        with self._diag_lock:
            self._diag['dropped']+=1
            self._diag[reason]+=1

    def diagnostics(self):
        with self._diag_lock:
            result=dict(self._diag)
            result['recentSessionEnds']=[dict(row) for row in self._session_ends]
            result['recentCaptureErrors']=[dict(row) for row in self._capture_error_events]
            if result['lastConnectFailure'] is not None:result['lastConnectFailure']=dict(result['lastConnectFailure'])
        elapsed=max(.001,time.monotonic()-self._started)
        result.update(timestamp=time.time(),elapsedSeconds=round(elapsed,3),
                      captureFps=round(result['captured']/elapsed,2),sentFps=round(result['sent']/elapsed,2))
        return result

    @staticmethod
    def _safe_close_code(code):
        return code if type(code) is int and code in (1000,1001,1002,1003,1005,1006,1007,1008,1009,1010,1011,1012,1013,1014,1015) else None

    def _record_exit(self,code,session_started,sent_before,*,ws_code=None,retry_ms=None,http_status=None):
        # Only finite categories/numbers. Never retain exception text, peer
        # reasons, URLs, credentials, stream IDs, bodies or frame pixels.
        code=code if isinstance(code,str) and code in _DIAGNOSTIC_CODES else 'unknown'
        retry_ms=retry_ms if type(retry_ms) is int and 0<=retry_ms<=30000 else None
        http_status=http_status if type(http_status)is int and 100<=http_status<=599 else None
        row={'atMs':round(time.time()*1000),'code':code,'webSocketCode':self._safe_close_code(ws_code),'httpStatus':http_status}
        with self._diag_lock:
            self._diag['nextRetryDelayMs']=retry_ms
            if session_started is None:
                self._diag['lastConnectFailure']=row
            else:
                delivered=max(0,self._diag['sent']-sent_before)
                row.update(durationMs=round(max(0,time.monotonic()-session_started)*1000),sentFrames=delivered,
                           firstFrameSentAtMs=self._diag['firstFrameSentAtMs'] if delivered else None,
                           lastFrameSentAtMs=self._diag['lastFrameSentAtMs'] if delivered else None,
                           plannedRetryDelayMs=retry_ms)
                self._session_ends.append(row)

    def write_status(self):
        if self.status_path:
            try: atomic_json(self.status_path,self.diagnostics())
            except (OSError,ValueError): pass

    def _eligible(self,client):
        try:
            with client._snapshot_lock:
                snap=client.snapshot
                svc=next((s for s in snap.get('services',[]) if s.get('id')==client.config['serviceId']),{})
                expires=svc.get('epochExpiresAt')
                return (snap.get('protocol')==1 and svc.get('config',{}).get('enabled') is True
                        and svc.get('epoch')==client.config['epoch']
                        and type(expires) in (int,float) and expires>time.time()*1000
                        and svc.get('config',{}).get('allowPreview') is True)
        except (KeyError,TypeError,AttributeError): return False

    def _choose(self):
        for client in self.clients:
            eligible=self._eligible(client)
            block=self._blocked.get(id(client))
            if not eligible:
                if block=='capability': self._blocked.pop(id(client),None)
                continue
            if not block: return client
        return None

    def _valid(self,client,generation):
        return (not self._stop.is_set() and self._demand and self._generation==generation
                and self._client is client and self._eligible(client))

    def _display_fence(self,client):
        """A RAM-only confirmation fence; no extra network status polling.

        Pause during pending/applying/unknown writes. A stable selected view can
        still preview at 2 FPS; pausing every selected item would disable preview
        for the entire lifetime of a source-ended service.
        """
        try:
            with client._snapshot_lock:
                s=client.snapshot
                if (not {'selected','applying','generation','health','displaying'}<=s.keys()
                        or s['applying'] is not None or s['health'].get('status')!='healthy'
                        or type(s['generation']) is not int):return None
                selected=s['selected']
                if selected is None:
                    return (s['generation'],None,None) if s['displaying'] is None else None
                if not isinstance(selected,str) or not selected:return None
                d=s['displaying']
                now=time.time()*1000
                if (not isinstance(d,dict) or d.get('itemKey')!=selected
                        or d.get('generation')!=s['generation']
                        or type(d.get('confirmedValidUntil')) not in (int,float)
                        or type(s['health'].get('confirmedValidUntil')) not in (int,float)
                        or min(d['confirmedValidUntil'],s['health']['confirmedValidUntil'])<=now):return None
                item=next((i for i in s.get('items',[]) if i.get('itemKey')==selected),None)
                version=None
                if item is not None:
                    proof=item.get('coverageProof') or {}
                    controller=proof.get('controller') or {}
                    if (item.get('state')=='applying' or proof.get('version')!=item.get('version')
                            or not isinstance(item.get('version'),int)
                            or controller.get('itemKey')!=selected
                            or controller.get('generation')!=s['generation']
                            or proof.get('validUntil',0)<=now):return None
                    version=item['version']
                return (s['generation'],selected,version)
        except (KeyError,TypeError,AttributeError):return None

    def _capture_ready(self,client,generation,fence=None):
        current=self._display_fence(client)
        return self._valid(client,generation) and current is not None and (fence is None or current==fence)

    def _discard_for_display(self):
        while not self._latest.empty():
            self._latest.get_nowait();self._drop('displayPausedDropped')

    def _invalidate(self):
        self._generation+=1; self._demand=False
        if self._active_send is not None and not self._active_send.done():
            self._active_send.cancel()
        while not self._latest.empty():
            self._latest.get_nowait(); self._drop('invalidatedDropped')
        self._update(demand=False,pausedForDisplay=False)

    async def _offload(self,work):
        # Identity uses the same exclusive slot as framebuffer reads, even
        # after a session cancellation while the bounded HTTP worker exits.
        self._busy[0]=True
        future=asyncio.get_running_loop().run_in_executor(self._executor,work)
        self._pending.add(future)
        def complete(done):
            self._pending.discard(done); self._busy[0]=False
        future.add_done_callback(complete)
        return await asyncio.shield(future)

    def _capture_failed(self,client,generation,error):
        self._count('captureErrors')
        current=self._valid(client,generation)
        code=error.code if isinstance(error.code,str) and error.code in _DIAGNOSTIC_CODES else 'unknown'
        with self._diag_lock:
            self._capture_error_events.append({'atMs':round(time.time()*1000),'code':code,'currentContext':current})
        if not current: return
        self._update(status=error.code)
        if error.code in ('auth','device_mismatch','redirect_refused'):
            self._blocked[id(client)]='terminal'
        if error.code in ('unavailable','timeout'):
            # A failed LAN read closes only its HTTP slot. Retain the cloud
            # session and heartbeat; bound retries when the device stays offline.
            self._capture_failures+=1
            self._capture_retry_at=time.monotonic()+min(2,.1*2**min(self._capture_failures-1,5))
            self._count('captureRetries')
            self._update(status='retrying-local',lastCaptureError=error.code)
            return
        # Identity/auth/protocol errors invalidate all queued work immediately.
        self._capture_error=error
        self._invalidate()

    def _submit_frame(self,device,slot,client,generation):
        fence=self._display_fence(client)
        if not self._capture_ready(client,generation,fence) or fence is None:
            self._update(pausedForDisplay=fence is None)
            return False
        if slot!=0 or any(self._busy) or self._pending:
            self._count('busySkipped');return False
        now=asyncio.get_running_loop().time()
        if now-self._last_capture_started<1/FPS:
            self._count('rateLimitedSkipped');return False
        self._last_capture_started=now
        self._busy[slot]=True; self._sequence+=1
        sequence=self._sequence; captured_at=int(time.time()*1000)
        self._count('captureRequested')
        future=asyncio.get_running_loop().run_in_executor(
            self._executor,lambda:device.frame(slot) if self._capture_ready(client,generation,fence) else None)
        self._pending.add(future)
        def complete(done):
            self._pending.discard(done); self._busy[slot]=False
            try: pixels=done.result()
            except PreviewError as error:
                self._capture_failed(client,generation,error); return
            except Exception:
                self._capture_failed(client,generation,PreviewError('unavailable')); return
            if pixels is None:
                self._drop('invalidatedDropped'); return
            self._count('captured')
            if not self._capture_ready(client,generation,fence):
                self._drop('invalidatedDropped'); return
            self._capture_failures=0; self._capture_retry_at=0
            self._update(status='capturing')
            if sequence<=self._last_sent:
                self._drop('outOfOrderDropped'); return
            if not self._latest.empty():
                queued_generation,queued=self._latest.get_nowait()
                if queued_generation==generation and queued['sequence']>sequence:
                    self._drop('outOfOrderDropped')
                    self._latest.put_nowait((queued_generation,queued)); return
                self._drop('supersededDropped' if queued_generation==generation else 'invalidatedDropped')
            self._latest.put_nowait((generation,{'type':'frame','sequence':sequence,
                                              'capturedAt':captured_at,'pixels':pixels,'_displayFence':fence}))
        future.add_done_callback(complete)
        return True

    async def _capture(self,client,device_id):
        device=None;verified=-1
        loop=asyncio.get_running_loop();period=1/FPS
        next_tick=None;last_tick=None
        while True:
            if self._capture_error is not None:raise self._capture_error
            generation=self._generation
            if not self._valid(client,generation):
                next_tick=None;self._update(pausedForDisplay=False)
                await asyncio.sleep(.02);continue
            fence=self._display_fence(client)
            if fence is None:
                self._update(pausedForDisplay=True,status='paused-for-display')
                self._discard_for_display();next_tick=None
                await asyncio.sleep(.02);continue
            self._update(pausedForDisplay=False)
            if loop.time()<self._capture_retry_at:
                await asyncio.sleep(min(.05,self._capture_retry_at-loop.time()))
                next_tick=None;continue
            if device is None:
                if self._device_future is None:
                    self._device_future=loop.run_in_executor(self._executor,
                        lambda:self.device_factory(self.runtime) if self._capture_ready(client,generation,fence) else None)
                    self._pending.add(self._device_future)
                    def remember(done):
                        self._pending.discard(done)
                        if not done.cancelled() and done.exception() is None:
                            if done.result() is not None:self._devices.append(done.result())
                            elif self._device_future is done:self._device_future=None
                    self._device_future.add_done_callback(remember)
                device=await asyncio.shield(self._device_future)
                if device is None:continue
            if not self._capture_ready(client,generation,fence):continue
            if verified!=generation:
                if any(self._busy):await asyncio.sleep(.01);continue
                def identify():
                    if not self._capture_ready(client,generation,fence):return False
                    device.verify(device_id);return True
                try:identified=await self._offload(identify)
                except PreviewError as error:
                    self._capture_failed(client,generation,error);continue
                if not identified or not self._valid(client,generation):continue
                verified=generation;next_tick=None
            now=loop.time()
            wake_at=now if next_tick is None else next_tick
            if last_tick is not None:wake_at=max(wake_at,last_tick+period)
            wake_at=max(wake_at,self._last_capture_started+period)
            if wake_at>now:
                await asyncio.sleep(wake_at-now)
                continue
            if any(self._busy) or self._pending:
                self._count('busySkipped');next_tick=None
                await asyncio.sleep(.02);continue
            self._update(status='capturing')
            last_tick=loop.time()
            # Schedule from this actual attempt, never repay missed deadlines.
            next_tick=last_tick+period
            self._submit_frame(device,0,client,generation)
            if loop.time()>=next_tick:await asyncio.sleep(0)

    async def _receive(self,ws,device_id):
        stream=None
        async for raw in ws:
            try:
                value=json.loads(raw) if isinstance(raw,str) and len(raw.encode('utf-8'))<=MAX_MESSAGE else None
            except (ValueError,UnicodeError,RecursionError): raise PreviewError('protocol') from None
            if isinstance(value,dict) and value=={'type':'error','code':'PREVIEW_NO_DEMAND'}:
                self._drop('noDemandDropped'); continue
            if (isinstance(value,dict) and set(value)=={'type','code'} and value['type']=='error'
                    and isinstance(value['code'],str) and value['code'] in _TRANSIENT_CLOUD_ERRORS):
                # Timing/rate rejection is not an identity or schema failure.
                # Invalidate this stream and reconnect through the normal backoff.
                self._update(lastCloudError=value['code'])
                raise PreviewError('unavailable')
            demand=parse_demand(raw,device_id)
            self._update(requestedTargetFps=demand['targetFps'])
            if stream is not None and stream!=demand['streamId']: raise PreviewError('protocol')
            stream=demand['streamId']
            if demand['enabled']!=self._demand:
                self._invalidate(); self._demand=demand['enabled']
                self._update(demand=self._demand,status='capturing' if self._demand else 'idle')

    async def _send(self,ws,client):
        while True:
            generation,frame=await self._latest.get()
            if not self._valid(client,generation):
                self._drop('invalidatedDropped'); continue
            if frame['sequence']<=self._last_sent:
                self._drop('outOfOrderDropped'); continue
            fence=frame.get('_displayFence')
            if not self._capture_ready(client,generation,fence):
                self._drop('displayPausedDropped');continue
            # Local confirmation fences never enter the wire/pixel protocol.
            wire={k:frame[k] for k in ('type','sequence','capturedAt','pixels')}
            raw=json.dumps(wire,separators=(',',':'),allow_nan=False)
            if len(raw.encode('utf-8'))>MAX_MESSAGE: raise PreviewError('frame')
            sending=asyncio.create_task(ws.send(raw))
            self._active_send=sending
            try:
                await asyncio.wait_for(sending,timeout=1)
            except asyncio.CancelledError:
                if not self._valid(client,generation):
                    self._drop('invalidatedDropped')
                    # A canceled partial socket write requires closing this
                    # session before reconnecting; never reuse its stream.
                    raise PreviewError('unavailable') from None
                raise
            finally:
                if self._active_send is sending: self._active_send=None
                if not sending.done(): sending.cancel()
                await asyncio.gather(sending,return_exceptions=True)
            if not self._capture_ready(client,generation,fence):
                self._drop('invalidatedDropped'); continue
            self._last_sent=frame['sequence']
            with self._diag_lock:
                self._diag['sent']+=1
                sent_at=round(time.time()*1000)
                self._diag['lastFrameSentAtMs']=sent_at
                if self._diag['firstFrameSentAtMs'] is None:self._diag['firstFrameSentAtMs']=sent_at

    async def _heartbeat(self,ws):
        while True:
            await asyncio.sleep(5)
            await asyncio.wait_for(ws.send('{"type":"heartbeat"}'),timeout=1)

    async def _diagnose(self):
        while True:
            self.write_status()
            await asyncio.sleep(1)

    async def _permission(self,client):
        while self._eligible(client) and id(client) not in self._blocked and not self._stop.is_set():
            await asyncio.sleep(.02)

    async def _session(self,ws,client,device_id):
        self._invalidate(); self._capture_error=None
        self._capture_failures=0; self._capture_retry_at=0
        self._count('connections')
        self._client=client; self._sequence=0; self._last_sent=0
        self._update(connected=True,status='idle',lastConnectedAtMs=round(time.time()*1000),
                     firstFrameSentAtMs=None,lastFrameSentAtMs=None,nextRetryDelayMs=None)
        tasks=[asyncio.create_task(work) for work in (self._receive(ws,device_id),self._send(ws,client),
                 self._capture(client,device_id),self._heartbeat(ws),self._permission(client),self._diagnose())]
        try:
            done,_=await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
            for task in done: task.result()
        finally:
            self._invalidate(); self._client=None; self._update(connected=False)
            self._count('disconnects')
            for task in tasks: task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)

    @staticmethod
    def _capability_error(error):
        if error.response.status_code!=403: return False
        try:
            raw=error.response.body
            return len(raw)<=2048 and json.loads(raw).get('error')=='PREVIEW_CAPABILITY_REQUIRED'
        except (ValueError,TypeError,AttributeError,RecursionError): return False

    @staticmethod
    def _handshake_code(error):
        # Keep only exact conflict enums, never the response body or peer text.
        if error.response.status_code!=409:return 'handshake_rejected'
        try:
            raw=error.response.body
            if len(raw)>2048:return 'handshake_rejected'
            value=json.loads(raw)
            code=value.get('error') if isinstance(value,dict) else None
            if code in ('PREVIEW_PUBLISHER_EXISTS','EPOCH_EXPIRED'):return code
        except (ValueError,TypeError,AttributeError,RecursionError):pass
        return 'handshake_rejected'

    async def run(self):
        self._loop=asyncio.get_running_loop(); self._task=asyncio.current_task()
        self._executor=ThreadPoolExecutor(max_workers=MAX_IN_FLIGHT,thread_name_prefix='busy-preview-http')
        backoff=1
        try:
            while not self._stop.is_set():
                client=self._choose()
                if client is None:
                    self._update(connected=False,demand=False)
                    await asyncio.sleep(.05); continue
                session_started=None; exit_code='session_ended'; ws_code=None; http_status=None
                with self._diag_lock: sent_before=self._diag['sent']
                try:
                    url,headers,device_id=client.http._preview_connection(client.config)
                    with client._snapshot_lock:
                        if client.snapshot.get('deviceId')!=device_id: raise PreviewError('device_mismatch')
                    async with NoRedirectConnect(url,additional_headers=headers,proxy=None,compression=None,
                            open_timeout=3,close_timeout=.3,ping_interval=10,ping_timeout=10,
                            max_size=MAX_MESSAGE,max_queue=4,logger=_QUIET) as ws:
                        session_started=time.monotonic()
                        await self._session(ws,client,device_id)
                        ws_code=self._safe_close_code(getattr(ws,'close_code',None))
                        exit_code='normal_close' if ws_code==1000 else 'session_ended'
                except InvalidStatus as error:
                    exit_code=self._handshake_code(error)
                    status=error.response.status_code
                    http_status=status
                    if status in (401,403):
                        capability=self._capability_error(error)
                        self._blocked[id(client)]='capability' if capability else 'terminal'
                        self._update(status='capability' if capability else 'auth')
                    elif 300<=status<400:
                        self._blocked[id(client)]='terminal'; self._update(status='redirect_refused')
                    else: self._update(status='unavailable')
                except (PreviewError,CloudError) as error:
                    code=error.code if isinstance(error,PreviewError) else 'auth'
                    exit_code=code
                    self._update(status=code)
                    if code not in ('unavailable','timeout'): self._blocked[id(client)]='terminal'
                except WebSocketException as error:
                    received=getattr(error,'rcvd',None)
                    reason=getattr(received,'reason','')
                    ws_code=self._safe_close_code(getattr(received,'code',None))
                    exit_code=('websocket_closed' if received is not None else 'no_close_frame') if hasattr(error,'rcvd') else 'websocket_error'
                    if isinstance(reason,str) and reason in _DIAGNOSTIC_PEER_CODES:exit_code=reason
                    sent=getattr(error,'sent',None)
                    if received is None and getattr(sent,'code',None)==1011 and getattr(sent,'reason',None)=='keepalive ping timeout':
                        exit_code='ping_timeout'
                    if isinstance(reason,str) and reason in _TRANSIENT_CLOUD_ERRORS:
                        self._update(lastCloudError=reason)
                    elif reason=='PREVIEW_CAPABILITY_REQUIRED': self._blocked[id(client)]='capability'
                    elif (getattr(received,'code',None)==1008
                          and reason not in ('PREVIEW_PUBLISHER_IDLE','PREVIEW_DISCONNECTED')):
                        self._blocked[id(client)]='terminal'
                    self._update(status='unavailable')
                except (OSError,TimeoutError,asyncio.TimeoutError,ValueError) as error:
                    exit_code='transport_timeout' if isinstance(error,(TimeoutError,asyncio.TimeoutError)) else 'transport_error'
                    self._update(status='unavailable')
                except asyncio.CancelledError:
                    exit_code='stopped' if self._stop.is_set() else 'cancelled'
                    raise
                except Exception:
                    exit_code='unexpected_error'
                    raise
                finally:
                    self._invalidate(); self._update(connected=False)
                    with self._diag_lock: delivered=self._diag['sent']>sent_before
                    # A handshake alone doesn't prove LAN capture or sustained
                    # socket health. Preserve retries across immediate failures.
                    if delivered or (session_started is not None and time.monotonic()-session_started>=15):
                        backoff=1
                    retry_ms=round(backoff*1000) if exit_code not in ('cancelled','stopped','unexpected_error') and not self._stop.is_set() and self._eligible(client) and id(client) not in self._blocked else None
                    self._record_exit(exit_code,session_started,sent_before,ws_code=ws_code,retry_ms=retry_ms,http_status=http_status)
                self.write_status()
                if self._eligible(client) and id(client) not in self._blocked:
                    # Interruptible backoff also observes capability revocation.
                    end=time.monotonic()+backoff
                    while time.monotonic()<end and self._eligible(client): await asyncio.sleep(.05)
                    backoff=min(backoff*2,30)
        finally:
            self._invalidate(); self._update(connected=False)
            await self.aclose()
            self.write_status(); self._loop=None; self._task=None

    async def aclose(self):
        # Real HTTP reads have a 300 ms deadline. Shielding keeps their slots
        # occupied until the worker actually exits, including canceled sessions.
        if self._pending: await asyncio.gather(*list(self._pending),return_exceptions=True)
        for device in self._devices: device.close()
        self._devices.clear()
        if self._executor:
            self._executor.shutdown(wait=True,cancel_futures=True); self._executor=None

    def start(self):
        if self._thread is not None: return
        def main():
            try: asyncio.run(self.run())
            except asyncio.CancelledError: pass
        self._thread=threading.Thread(target=main,name='busy-cloud-preview',daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._loop and self._task:
            try: self._loop.call_soon_threadsafe(self._task.cancel)
            except RuntimeError: pass
        if self._thread: self._thread.join(timeout=6)
        self.write_status()

    def is_alive(self):
        return self._thread is not None and self._thread.is_alive()
