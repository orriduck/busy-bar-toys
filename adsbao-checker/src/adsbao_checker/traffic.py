"""Public ADSBao SSE contract. No upstream provider implementation or credentials."""
import asyncio
from dataclasses import dataclass
from datetime import datetime
import json
import math
import re
import threading
import time
import httpx2

ORIGIN='https://adsbao.dev'
MAX_EVENT=262144


def number(value):
    try:return float(value) if type(value) in (int,float) and math.isfinite(value) else None
    except OverflowError:return None


def timestamp(value):
    if (result:=number(value)) is not None:return result
    try:return datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
    except (TypeError,ValueError,AttributeError,OverflowError):return None


def fresh(value,now):
    return value is not None and -5<=now-value<=60


@dataclass(frozen=True)
class Aircraft:
    hex: str
    callsign: str
    registration: str
    kind: str
    latitude: float
    longitude: float
    fix_at: float
    altitude: float | None = None

    @property
    def identity(self):return self.callsign or self.registration or self.hex.upper()


@dataclass(frozen=True)
class TrafficFrame:
    channel: str
    sequence: int
    fetched_at: float
    aircraft: tuple[Aircraft,...]


def clean_text(value,limit=12):
    return ''.join(c for c in str(value or '').strip().upper() if c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-')[:limit]


def parse_envelope(payload,*,now=None):
    now=time.time() if now is None else now
    if not isinstance(payload,dict) or payload.get('stale') is not False:return None
    emitted=timestamp(payload.get('emittedAt'));fetched=timestamp(payload.get('fetchedAt',payload.get('emittedAt')))
    if not fresh(emitted,now) or not fresh(fetched,now):return None
    channel=payload.get('channel');sequence=payload.get('sequence')
    if not isinstance(channel,str) or not channel.startswith('nearby:') or type(sequence) is not int or sequence<0:return None
    data=payload.get('data');raw=data.get('aircraft') if isinstance(data,dict) else None
    records=raw.get('ac') if isinstance(raw,dict) else raw
    if not isinstance(records,list) or len(records)>5000:return None
    planes=[]
    for record in records:
        if not isinstance(record,dict):continue
        hex=record.get('hex');lat=number(record.get('lat'));lon=number(record.get('lon'))
        if not isinstance(hex,str) or not re.fullmatch(r'[0-9a-fA-F]{6}',hex):continue
        if lat is None or lon is None or not -90<=lat<=90 or not -180<=lon<=180:continue
        if record.get('alt_baro')=='ground' or record.get('on_ground') is True or record.get('ground') is True:continue
        fix=timestamp(record.get('fixAt'))
        if fix is None and (age:=number(record.get('seen_pos'))) is not None and age>=0:fix=fetched-age
        if not fresh(fix,now):continue
        planes.append(Aircraft(hex.lower(),clean_text(record.get('flight'),8),clean_text(record.get('r')),
                              clean_text(record.get('t'),6),lat,lon,fix,number(record.get('alt_baro'))))
    return TrafficFrame(channel,sequence,fetched,tuple(planes))


def coordinate_channel(latitude,longitude):
    if number(latitude) is None or number(longitude) is None or not -90<=latitude<=90 or not -180<=longitude<=180:
        raise ValueError('Invalid observation point')
    lat=round(latitude,2);lon=round(longitude,2)
    return f'nearby:{0 if lat==0 else lat:.2f}:{0 if lon==0 else lon:.2f}'


def sse_events(stream):
    """Yield complete named events; bound lines and accumulated payload size."""
    event='message';data=[];size=0
    while True:
        raw=stream.readline(MAX_EVENT+1)
        if not raw:return
        if len(raw)>MAX_EVENT:raise ValueError('ADSBao event exceeded the size limit')
        line=raw.decode('utf-8').rstrip('\r\n')
        if not line:
            if data:yield event,'\n'.join(data)
            event='message';data=[];size=0;continue
        if line.startswith(':'):continue
        field,separator,value=line.partition(':')
        if value.startswith(' '):value=value[1:]
        if field=='event':event=value
        elif field=='data':
            size+=len(raw)
            if size>MAX_EVENT:raise ValueError('ADSBao event exceeded the size limit')
            data.append(value)


async def async_events(response):
    event='message';data=[];size=0;buffer=b''
    async for chunk in response.aiter_bytes(chunk_size=None):
        buffer+=chunk
        while b'\n' in buffer:
            raw,buffer=buffer.split(b'\n',1)
            if len(raw)>MAX_EVENT:raise ValueError('Oversized SSE line')
            line=raw.decode('utf-8').rstrip('\r')
            if not line:
                if data:yield event,'\n'.join(data)
                event='message';data=[];size=0;continue
            if line.startswith(':'):continue
            field,_,value=line.partition(':')
            if value.startswith(' '):value=value[1:]
            if field=='event':event=value
            elif field=='data':
                size+=len(raw)
                if size>MAX_EVENT:raise ValueError('Oversized SSE event')
                data.append(value)
        if len(buffer)>MAX_EVENT:raise ValueError('Oversized SSE line')


class TrafficMonitor:
    """One cancellable stream, one latest frame, no unbounded alert queue."""
    def __init__(self,*,origin=ORIGIN,clock=None):
        self._origin=origin;self._clock=clock or time.time
        self._lock=threading.Lock();self._stop=threading.Event();self._ready=threading.Event()
        self._channel=None;self._frame=None;self._thread=None;self._loop=None
        self._main_task=None;self._connection=None
        self._connected=False;self._error='no_location'

    def update_location(self,fix):
        channel=coordinate_channel(fix.latitude,fix.longitude) if fix else None
        with self._lock:
            if channel==self._channel:return
            self._channel=channel;self._frame=None;self._connected=False
            self._error='connecting' if channel else 'no_location'
        loop=self._loop
        if loop and not loop.is_closed():
            try:loop.call_soon_threadsafe(self._cancel_connection)
            except RuntimeError:pass

    def _cancel_connection(self):
        if self._connection:self._connection.cancel()

    def start(self):
        self._thread=threading.Thread(target=self._run,name='adsbao-stream',daemon=True)
        self._thread.start();self._ready.wait(1)

    def stop(self):
        self._stop.set();loop=self._loop
        if loop and not loop.is_closed():
            try:loop.call_soon_threadsafe(self._main_task.cancel)
            except RuntimeError:pass
        if self._thread:self._thread.join(timeout=2)
        with self._lock:self._connected=False

    def latest(self,*,now=None):
        now=self._clock() if now is None else now
        with self._lock:
            frame=self._frame
            return frame if self._connected and frame and fresh(frame.fetched_at,now) else None

    def status(self):
        with self._lock:
            age=max(0,self._clock()-self._frame.fetched_at) if self._frame else None
            return {'connected':self._connected and age is not None and age<=60,
                    'error':self._error if age is None or age<=60 else 'stale',
                    'data_age_seconds':round(age,1) if age is not None else None}

    async def _read(self,client,channel):
        _,lat,lon=channel.split(':')
        async with client.stream('GET',f'{self._origin}/events/nearby/coordinates/{lat}/{lon}') as response:
            response.raise_for_status()
            if 'text/event-stream' not in response.headers.get('Content-Type',''):
                raise ValueError('Invalid stream content type')
            sequence=-1
            async for event,raw in async_events(response):
                if event not in ('nearby:snapshot','nearby:traffic','nearby:status'):continue
                envelope=json.loads(raw)
                # Discard obsolete envelopes before stale/pending handling.
                if isinstance(envelope,dict):
                    incoming=envelope.get('sequence')
                    if envelope.get('channel')!=channel or (type(incoming) is int and incoming<=sequence):continue
                    if type(incoming) is int and incoming>=0:sequence=incoming
                frame=parse_envelope(envelope,now=self._clock())
                if frame is None:
                    with self._lock:self._connected=False;self._error='stale_or_pending'
                    continue
                if frame.channel!=channel:continue
                with self._lock:
                    if channel==self._channel:
                        self._frame=frame;self._connected=True;self._error=''

    async def _main(self):
        backoff=2
        async with httpx2.AsyncClient(timeout=httpx2.Timeout(20,connect=10),follow_redirects=False,
                headers={'Accept':'text/event-stream','User-Agent':'busy-bar-status/0.1'}) as client:
            while not self._stop.is_set():
                with self._lock:channel=self._channel
                if not channel:await asyncio.sleep(.5);continue
                self._connection=asyncio.create_task(self._read(client,channel))
                try:
                    await self._connection
                except asyncio.CancelledError:
                    if self._stop.is_set():raise
                except (httpx2.HTTPError,OSError,ValueError,UnicodeError,RecursionError):
                    with self._lock:self._connected=False;self._error='unavailable'
                finally:
                    self._connection=None
                    with self._lock:
                        was_connected=self._connected;self._connected=False
                if self._stop.is_set():break
                with self._lock:changed=channel!=self._channel
                if changed:continue
                if was_connected:backoff=2
                await asyncio.sleep(backoff);backoff=min(60,backoff*2)

    def _run(self):
        async def run():
            self._loop=asyncio.get_running_loop();self._main_task=asyncio.current_task();self._ready.set()
            try:await self._main()
            except asyncio.CancelledError:pass
        asyncio.run(run())
