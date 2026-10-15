"""Optional read-only LAN framebuffer bridge. Credentials and pixels stay transient.

Cloud socket supervision, capture scheduling, and local HTTP reads run separately
from the collector, publisher, input monitor, actions, and urgent watchdog.
"""
import asyncio
import base64
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
FPS = 30
_HEX = re.compile(r'^[a-f0-9]{64}$')
_STREAM = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
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
                or type(value['targetFps']) is not int or value['targetFps']!=FPS
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
    """Four exclusive HTTP slots; one bounded read per slot, no proxy/redirect."""
    def __init__(self,addr,token):
        self._host,self._port=private_address(addr)
        if not isinstance(token,str) or not token or any(c.isspace() for c in token):
            raise PreviewError('auth')
        self._token=token
        self._connections=[None]*4

    def _get(self,slot,path,limit):
        if slot not in range(4) or path not in ('/api/status','/api/status/device','/api/screen?display=0'):
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
        self._connections=[None]*4


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
        self.clients=[clients[k] for k in ('agent','notifier') if k in clients]
        self.device_factory=device_factory
        self.status_path=self.runtime/'preview-status.json' if status_path is True else status_path
        self._stop=threading.Event(); self._thread=None; self._loop=None; self._task=None
        self._executor=None; self._pending=set(); self._busy=[False]*4; self._devices=[]; self._device_future=None
        self._blocked={}; self._generation=0; self._demand=False; self._client=None
        self._latest=asyncio.Queue(maxsize=1); self._sequence=0; self._last_sent=0
        self._diag_lock=threading.Lock(); self._started=time.monotonic()
        self._diag={'status':'idle','connected':False,'demand':False,'captureRequested':0,
                    'captured':0,'sent':0,'dropped':0,'busySkipped':0,'captureErrors':0}

    def _update(self,**values):
        with self._diag_lock: self._diag.update(values)

    def _count(self,key):
        with self._diag_lock: self._diag[key]+=1

    def diagnostics(self):
        with self._diag_lock: result=dict(self._diag)
        elapsed=max(.001,time.monotonic()-self._started)
        result.update(timestamp=time.time(),elapsedSeconds=round(elapsed,3),
                      captureFps=round(result['captured']/elapsed,2),sentFps=round(result['sent']/elapsed,2))
        return result

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
                return (snap.get('protocol')==1 and svc.get('enabled') is True
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

    def _invalidate(self):
        self._generation+=1; self._demand=False
        while not self._latest.empty():
            self._latest.get_nowait(); self._count('dropped')
        self._update(demand=False)

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

    def _submit_frame(self,device,slot,client,generation):
        self._busy[slot]=True; self._sequence+=1
        sequence=self._sequence; captured_at=int(time.time()*1000)
        self._count('captureRequested')
        future=asyncio.get_running_loop().run_in_executor(
            self._executor,lambda:device.frame(slot) if self._valid(client,generation) else None)
        self._pending.add(future)
        def complete(done):
            self._pending.discard(done); self._busy[slot]=False
            try: pixels=done.result()
            except PreviewError as error:
                self._count('captureErrors'); self._update(status=error.code)
                if error.code in ('auth','device_mismatch','redirect_refused'):
                    self._blocked[id(client)]='terminal'; self._invalidate()
                return
            except Exception:
                self._count('captureErrors'); self._update(status='unavailable'); return
            if pixels is None:
                self._count('dropped'); return
            self._count('captured')
            if not self._valid(client,generation) or sequence<=self._last_sent:
                self._count('dropped'); return
            if not self._latest.empty():
                queued_generation,queued=self._latest.get_nowait()
                self._count('dropped')
                if queued_generation==generation and queued['sequence']>sequence:
                    self._latest.put_nowait((queued_generation,queued)); return
            self._latest.put_nowait((generation,{'type':'frame','sequence':sequence,
                                              'capturedAt':captured_at,'pixels':pixels}))
        future.add_done_callback(complete)

    async def _capture(self,client,device_id):
        device=None; verified=-1
        while True:
            generation=self._generation
            if not self._valid(client,generation):
                await asyncio.sleep(.02); continue
            if device is None:
                if self._device_future is None:
                    self._device_future=asyncio.get_running_loop().run_in_executor(
                        self._executor,self.device_factory,self.runtime)
                    self._pending.add(self._device_future)
                    def remember(done):
                        self._pending.discard(done)
                        if not done.cancelled() and done.exception() is None: self._devices.append(done.result())
                    self._device_future.add_done_callback(remember)
                device=await asyncio.shield(self._device_future)
            if not self._valid(client,generation): continue
            if verified!=generation:
                # Slot 0 may still contain an old-generation request. Wait for
                # all outstanding reads before identity verification or reuse.
                if any(self._busy): await asyncio.sleep(.01); continue
                await self._offload(lambda:device.verify(device_id) if self._valid(client,generation) else None)
                if not self._valid(client,generation): continue
                verified=generation
            self._update(status='capturing')
            try: slot=self._busy.index(False)
            except ValueError: self._count('busySkipped')
            else: self._submit_frame(device,slot,client,generation)
            # One central tick starts at most one read. A slow tick never catches
            # up by issuing a burst of requests after work or event-loop stalls.
            await asyncio.sleep(1/FPS)

    async def _receive(self,ws,device_id):
        stream=None
        async for raw in ws:
            try:
                value=json.loads(raw) if isinstance(raw,str) and len(raw.encode('utf-8'))<=MAX_MESSAGE else None
            except (ValueError,UnicodeError,RecursionError): raise PreviewError('protocol') from None
            if isinstance(value,dict) and value=={'type':'error','code':'PREVIEW_NO_DEMAND'}:
                self._count('dropped'); continue
            demand=parse_demand(raw,device_id)
            if stream is not None and stream!=demand['streamId']: raise PreviewError('protocol')
            stream=demand['streamId']
            if demand['enabled']!=self._demand:
                self._invalidate(); self._demand=demand['enabled']
                self._update(demand=self._demand,status='capturing' if self._demand else 'idle')

    async def _send(self,ws,client):
        while True:
            generation,frame=await self._latest.get()
            if not self._valid(client,generation) or frame['sequence']<=self._last_sent:
                self._count('dropped'); continue
            raw=json.dumps(frame,separators=(',',':'),allow_nan=False)
            if len(raw.encode('utf-8'))>MAX_MESSAGE: raise PreviewError('frame')
            await asyncio.wait_for(ws.send(raw),timeout=1)
            self._last_sent=frame['sequence']; self._count('sent')

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
        self._invalidate(); self._client=client; self._sequence=0; self._last_sent=0
        self._update(connected=True,status='idle')
        tasks=[asyncio.create_task(work) for work in (self._receive(ws,device_id),self._send(ws,client),
                 self._capture(client,device_id),self._heartbeat(ws),self._permission(client),self._diagnose())]
        try:
            done,_=await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
            for task in done: task.result()
        finally:
            self._invalidate(); self._client=None; self._update(connected=False)
            for task in tasks: task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)

    @staticmethod
    def _capability_error(error):
        if error.response.status_code!=403: return False
        try:
            raw=error.response.body
            return len(raw)<=2048 and json.loads(raw).get('error')=='PREVIEW_CAPABILITY_REQUIRED'
        except (ValueError,TypeError,AttributeError,RecursionError): return False

    async def run(self):
        self._loop=asyncio.get_running_loop(); self._task=asyncio.current_task()
        self._executor=ThreadPoolExecutor(max_workers=4,thread_name_prefix='busy-preview-http')
        backoff=1
        try:
            while not self._stop.is_set():
                client=self._choose()
                if client is None:
                    self._update(connected=False,demand=False)
                    await asyncio.sleep(.05); continue
                try:
                    url,headers,device_id=client.http._preview_connection(client.config)
                    with client._snapshot_lock:
                        if client.snapshot.get('deviceId')!=device_id: raise PreviewError('device_mismatch')
                    async with NoRedirectConnect(url,additional_headers=headers,proxy=None,compression=None,
                            open_timeout=3,close_timeout=.3,ping_interval=10,ping_timeout=10,
                            max_size=MAX_MESSAGE,max_queue=4,logger=_QUIET) as ws:
                        backoff=1
                        await self._session(ws,client,device_id)
                except InvalidStatus as error:
                    status=error.response.status_code
                    if status in (401,403):
                        capability=self._capability_error(error)
                        self._blocked[id(client)]='capability' if capability else 'terminal'
                        self._update(status='capability' if capability else 'auth')
                    elif 300<=status<400:
                        self._blocked[id(client)]='terminal'; self._update(status='redirect_refused')
                    else: self._update(status='unavailable')
                except (PreviewError,CloudError) as error:
                    code=error.code if isinstance(error,PreviewError) else 'auth'
                    self._update(status=code)
                    if code not in ('unavailable','timeout'): self._blocked[id(client)]='terminal'
                except WebSocketException as error:
                    received=getattr(error,'rcvd',None)
                    reason=getattr(received,'reason','')
                    if reason=='PREVIEW_CAPABILITY_REQUIRED': self._blocked[id(client)]='capability'
                    elif getattr(received,'code',None)==1008: self._blocked[id(client)]='terminal'
                    self._update(status='unavailable')
                except (OSError,TimeoutError,ValueError): self._update(status='unavailable')
                finally:
                    self._invalidate(); self._update(connected=False)
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
