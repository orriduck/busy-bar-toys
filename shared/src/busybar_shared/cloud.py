"""Scoped control-plane producer. This module never opens a BUSY device endpoint.

The collector, publisher, SSE receiver, action executor and urgent watchdog have
separate execution paths. Durable state contains presentation data, never secrets.
"""
import base64
import copy
from collections import deque
import hashlib
from http.client import HTTPException
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

from .connection_lifecycle import PeriodicChannel, SnapshotStreamChannel
from .service_queue import ServiceQueue

MAX_RESPONSE = 4 * 1024 * 1024
LOCAL_ASSET_COUNT = 128
LOCAL_ASSET_BYTES = 8 * 1024 * 1024
LOCAL_RECORDS = 4096
LOCAL_ACTIONS = 512
LOCAL_INPUTS = 2048
LOCAL_STATE_BYTES = 32 * 1024 * 1024
ASSET_ENCODING_VERSION = 'native-rle-v1'
DELIVERY_FAILURE_REASONS = frozenset(('expired', 'epoch-expired', 'epoch_expired', 'heartbeat-expired', 'source-expired'))
IDENTIFIER = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
HELPER = Path(__file__).resolve().parents[3] / '.venv/bin/busy-cloud-keychain'


class CloudError(RuntimeError):
    """A bounded error with no server body, URL or secret in its message."""
    def __init__(self, code='unavailable', status=None):
        self.code, self.status = code, status
        super().__init__('Control plane: ' + code)


def base_url(value):
    try:
        p = urlsplit(value)
        if p.username is not None or p.password is not None or p.query or p.fragment or p.path not in ('', '/'):
            raise ValueError()
        if not p.hostname or p.port is not None and not 1 <= p.port <= 65535:
            raise ValueError()
        local = p.hostname == 'localhost'
        try: local = local or ipaddress.ip_address(p.hostname).is_loopback
        except ValueError: pass
        if p.scheme != 'https' and not (p.scheme == 'http' and local): raise ValueError()
        return value.rstrip('/')
    except (ValueError, TypeError):
        raise ValueError('Use an HTTPS origin, or HTTP loopback for a local demo.') from None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise CloudError('redirect_refused')


class Transport:
    def __init__(self, url, credential, *, timeout=5, opener=None, service_id=None):
        self.url = base_url(url)
        if not credential or any(c.isspace() for c in credential): raise CloudError('invalid_credential')
        self._credential = credential
        if service_id is not None and (not isinstance(service_id,str) or not IDENTIFIER.fullmatch(service_id)
                                       or service_id in ('__proto__','constructor','prototype')):
            raise CloudError('invalid_service')
        self.service_id = service_id
        self.timeout = timeout
        self._opener = opener or build_opener(NoRedirect())

    def _preview_connection(self, config):
        """Private in-memory handoff to the optional local preview bridge."""
        parts=self._credential.split('.')
        computer=len(parts)==4 and parts[1]=='c'
        if len(parts) not in (3,4) or len(parts)==4 and not computer or not re.fullmatch(r'[a-f0-9]{64}',parts[0]):
            raise CloudError('invalid_credential')
        if computer:
            if parts[2]!=config.get('computerId') or not IDENTIFIER.fullmatch(config.get('serviceId','')):
                raise CloudError('invalid_credential')
        elif parts[1]!=config.get('serviceId',parts[1]): raise CloudError('invalid_credential')
        if self.service_id is not None and self.service_id!=config.get('serviceId'): raise CloudError('invalid_config')
        try:
            if not IDENTIFIER.fullmatch(config['instanceId']): raise ValueError()
            epoch=config['epoch']
            if not isinstance(epoch,str) or not epoch or len(epoch)>256 or any(c.isspace() for c in epoch): raise ValueError()
        except (KeyError,ValueError,TypeError): raise CloudError('invalid_config') from None
        origin=urlsplit(self.url)
        scheme='wss' if origin.scheme=='https' else 'ws'
        headers={'Authorization':'Bearer '+self._credential,'X-Busy-Instance':config['instanceId'],'X-Busy-Epoch':epoch}
        if computer or self.service_id is not None: headers['X-Busy-Service']=config['serviceId']
        return (scheme+'://'+origin.netloc+'/api/preview/publish',headers,parts[0])

    def _open(self, method, path, body=None):
        if not path.startswith('/api/') or '?' in path or '#' in path: raise CloudError('invalid_path')
        headers = {'Authorization':'Bearer ' + self._credential, 'Accept':'application/json',
                   'User-Agent':'busy-bar-toys/0.1'}
        if self.service_id is not None: headers['X-Busy-Service']=self.service_id
        data = None if body is None else json.dumps(body, separators=(',',':'),allow_nan=False).encode()
        if data is not None:
            if len(data) > 512 * 1024: raise CloudError('request_too_large')
            headers['Content-Type'] = 'application/json'
        try:
            return self._opener.open(Request(self.url+path,data=data,headers=headers,method=method), timeout=self.timeout)
        except HTTPError as error:
            code='unauthorized' if error.code in (401,403) else 'http_' + str(error.code)
            try:
                if error.code==403:
                    # Only these fixed protocol codes can change retry policy.
                    # Never expose arbitrary remote bodies, even on failures.
                    raw=error.read(2049)
                    if len(raw)<=2048:
                        try: remote=json.loads(raw)
                        except (ValueError,UnicodeError,RecursionError): remote={}
                        if isinstance(remote,dict):
                            if remote.get('error')=='ASSET_NOT_AUTHORIZED': code='asset_not_authorized'
                            elif path=='/api/input' and remote.get('error')=='FORBIDDEN': code='input_forbidden'
            except (OSError,HTTPException):
                raise CloudError('unavailable') from None
            finally: error.close()
            raise CloudError(code,error.code) from None
        except (URLError, OSError, TimeoutError, HTTPException, ValueError):
            raise CloudError('unavailable') from None

    def request(self, method, path, body=None):
        try:
            with self._open(method,path,body) as response:
                expected=response.headers.get('Content-Length')
                raw=response.read(MAX_RESPONSE+1)
                if len(raw)>MAX_RESPONSE: raise CloudError('response_too_large')
                if isinstance(expected,str) and expected.isdigit() and int(expected)!=len(raw):
                    raise CloudError('incomplete_response')
                try:
                    value=json.loads(raw)
                    if not isinstance(value,dict): raise ValueError()
                    return value
                except (ValueError, UnicodeError, RecursionError):
                    raise CloudError('invalid_response') from None
        except (OSError,HTTPException):
            raise CloudError('unavailable') from None

    def events(self):
        try:
            with self._open('GET','/api/events') as response:
                # readline's explicit limit bounds a peer with no newline.
                yield from parse_sse(iter(lambda:response.readline(MAX_RESPONSE+1),b''))
        except (OSError,HTTPException):
            raise CloudError('sse_unavailable') from None


def parse_sse(lines):
    event=''; data=[]; size=0
    for line in lines:
        size += len(line)
        if size > MAX_RESPONSE: raise CloudError('sse_too_large')
        try: line=line.decode('utf-8').rstrip('\r\n') if isinstance(line,bytes) else line.rstrip('\r\n')
        except UnicodeError: raise CloudError('invalid_sse') from None
        if not line:
            if event=='snapshot' and data:
                try:
                    value=json.loads('\n'.join(data))
                    if not isinstance(value,dict): raise ValueError()
                except (ValueError, RecursionError): raise CloudError('invalid_sse') from None
                yield value
            event=''; data=[]; size=0
        elif line.startswith('event:'): event=line[6:].lstrip(' ')
        elif line.startswith('data:'): data.append(line[5:].lstrip(' '))


def _atomic_bytes(path, raw):
    path=Path(path); path.parent.mkdir(parents=True,mode=0o700,exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='wb',dir=path.parent,delete=False) as stream:
        tmp=Path(stream.name)
        try:
            os.chmod(tmp,0o600)
            stream.write(raw)
            stream.flush(); os.fsync(stream.fileno()); tmp.replace(path)
        finally: tmp.unlink(missing_ok=True)


def atomic_json(path, data):
    _atomic_bytes(path,json.dumps(data,separators=(',',':'),allow_nan=False).encode())


def keychain(role, value=None):
    if role not in ('agent','notifier','computer'): raise ValueError('Invalid cloud role')
    try:
        result=subprocess.run([str(HELPER),'get' if value is None else 'set',role],input=value,
                              text=True,capture_output=True,timeout=10)
    except (OSError,subprocess.SubprocessError): raise CloudError('keychain_unavailable') from None
    if result.returncode: raise CloudError('keychain_unavailable')
    if value is None:
        secret=result.stdout.strip()
        if not secret or any(c.isspace() for c in secret): raise CloudError('invalid_credential')
        return secret


def validated_fallback(value):
    if type(value) is not int or not 1<=value<=300:
        raise ValueError('Fallback seconds must be an integer from 1 to 300.')
    return value


def load_config(runtime, role):
    try:
        path=Path(runtime)/('cloud-'+role+'.json')
        raw=path.read_bytes()
        if len(raw)>4096: raise ValueError()
        value=json.loads(raw)
        if value['role']!=role or not all(IDENTIFIER.fullmatch(value[k]) for k in ('serviceId','instanceId')):
            raise ValueError()
        base_url(value['url'])
        if not isinstance(value['epoch'],str) or not value['epoch']: raise ValueError()
        value['fallbackSeconds']=validated_fallback(value.get('fallbackSeconds',10))
        return value
    except (OSError, ValueError, KeyError, TypeError): raise CloudError('setup_required_'+role) from None


def setup(runtime, url, role, *, instance=None, secret, fallback_seconds=10, store=keychain, transport=Transport):
    url=base_url(url)
    fallback_seconds=validated_fallback(fallback_seconds)
    if role not in ('agent','notifier') or instance is not None and not IDENTIFIER.fullmatch(instance):
        raise ValueError('Use role agent or notifier and a 1..64 character instance name (letters, digits, _ or -).')
    snapshot=transport(url,secret).request('GET','/api/snapshot')
    services=snapshot.get('services',[])
    if snapshot.get('protocol')!=1 or len(services)!=1 or services[0].get('template')!=role:
        raise CloudError('credential_role_mismatch')
    service=services[0]
    if not IDENTIFIER.fullmatch(service.get('id','')) or not service.get('epoch'): raise CloudError('invalid_response')
    try: previous=load_config(runtime,role)
    except CloudError: previous={}
    # New roles on one installation share a source-computer ID. Never rekey an existing role.
    try: peer=load_config(runtime,'notifier' if role=='agent' else 'agent')
    except CloudError: peer={}
    config={'url':url,'role':role,'serviceId':service['id'],'epoch':service['epoch'],
            'epochExpiresAt':service.get('epochExpiresAt'),'fallbackSeconds':fallback_seconds,
            'instanceId':instance or previous.get('instanceId') or peer.get('instanceId') or 'mac-'+uuid.uuid4().hex[:16]}
    store(role,secret)
    atomic_json(Path(runtime)/('cloud-'+role+'.json'),config)
    return config


class State:
    """Atomic durable producer outbox and occurrence ledger, shared by local threads."""
    def __init__(self,path,*,clock=None,fallback_seconds=10):
        self.fallback_ms=validated_fallback(fallback_seconds)*1000
        self.path=Path(path); self.clock=clock or time.time; self.lock=threading.RLock()
        try:
            raw=self.path.read_bytes()
            if len(raw)>LOCAL_STATE_BYTES: raise ValueError()
            self.data=json.loads(raw)
            if not isinstance(self.data.get('records'),dict): raise ValueError()
        except FileNotFoundError: self.data={'records':{},'actions':{},'assets':{},'inputs':{}}
        except (ValueError, OSError): raise CloudError('state_unreadable') from None
        self.records=self.data['records']
        self.data.setdefault('ends',{})

    def save(self):
        raw=json.dumps(self.data,separators=(',',':'),allow_nan=False).encode()
        if len(raw)>LOCAL_STATE_BYTES:
            raise CloudError('local_state_capacity')
        _atomic_bytes(self.path,raw)

    @staticmethod
    def compact(record,*,keep_fallback=False):
        for field in ('scene','update','publishBody','updateBody','signature','frameSignature','detail','title','localFingerprint'):
            if keep_fallback and field in ('title','detail'): continue
            record.pop(field,None)

    def trim_assets(self,protect=None):
        pinned=set()
        def visit(value):
            if isinstance(value,dict):
                if 'assetHash' in value: pinned.add(value['assetHash'])
                for child in value.values(): visit(child)
            elif isinstance(value,(tuple,list)):
                for child in value: visit(child)
        for record in self.records.values():
            if not record.get('cleared') and not record.get('tombstone'): visit(record)
        if protect: pinned.add(protect)
        assets=self.data['assets']
        while len(assets)>LOCAL_ASSET_COUNT or sum(len(a['data'])*3//4 for a in assets.values())>LOCAL_ASSET_BYTES:
            candidates=[key for key in assets if key not in pinned]
            if not candidates: raise CloudError('local_asset_capacity')
            oldest=min(candidates,key=lambda key:assets[key].get('usedAt',0))
            del assets[oldest]

    def recognize(self,key,**content):
        with self.lock:
            rec=self.records.get(key)
            if rec and rec.get('tombstone') and not rec.get('cleared'): return None
            if rec is None or rec.get('cleared'):
                if rec is None and len(self.records)>=LOCAL_RECORDS: raise CloudError('local_occurrence_capacity')
                now=int(self.clock()*1000)
                rec={'itemId':str(uuid.uuid4()),'firstRecognizedAt':now,'version':0,'acked':0,
                     'deadline':self.data.get('watchClock',{}).get('utc',now)+self.fallback_ms,'notified':False,'lastSourceAt':now}
                self.records[key]=rec
            signature=json.dumps(content,sort_keys=True,separators=(',',':'),allow_nan=False)
            if signature != rec.get('signature'):
                rec['version']+=1; rec.update(copy.deepcopy(content)); rec['signature']=signature
                rec.pop('update',None)
                rec.pop('publishBody',None)
                rec.pop('updateBody',None)
            rec['lastSourceAt']=int(self.clock()*1000)
            rec['sourceUnknown']=False
            rec.pop('handoverPendingSource',None)
            self.save(); return copy.deepcopy(rec)

    def clear(self,key,*,withdraw=False):
        with self.lock:
            rec=self.records.get(key)
            if rec and not rec.get('cleared'):
                if rec.get('tombstone'):
                    rec['cleared']=True; rec['fallbackPending']=False; self.compact(rec); self.save(); return
                if len(self.data['ends'])>=LOCAL_RECORDS: raise CloudError('local_end_capacity')
                rec['cleared']=True; rec['version']+=1
                self.data['ends'][rec['itemId']]={'itemId':rec['itemId'],'version':rec['version'],**({'withdraw':True} if withdraw else {})}
                self.compact(rec)
                self.save()

    def unknown(self,source):
        with self.lock:
            for key,rec in self.records.items():
                if key.startswith(source+':'): rec['sourceUnknown']=True
            self.save()

    def tombstone(self,item_id,reason,*,record_keys=None):
        with self.lock:
            changed=[]
            candidates=self.records.values() if record_keys is None else (self.records.get(key) for key in record_keys)
            for rec in candidates:
                # Hints are checked under the same lock: a source may have
                # replaced an occurrence since its receipt index was built.
                if rec is not None and rec['itemId']==item_id:
                    before=rec.copy()
                    rec['tombstone']=reason; rec['acked']=rec['version']; rec.pop('ending',None)
                    rec['fallbackPending']=(reason in DELIVERY_FAILURE_REASONS and rec.get('level')=='urgent'
                                            and not rec.get('cleared') and not rec.get('notified'))
                    self.compact(rec,keep_fallback=rec['fallbackPending'])
                    if rec!=before: changed.append((rec,before))
            if changed:
                try: self.save()
                except Exception:
                    # A later snapshot must retry a receipt that was not durable.
                    for rec,before in changed:
                        rec.clear(); rec.update(before)
                    raise
            return bool(changed)


class Watchdog:
    """No I/O dependency: local time + finite matching backend proof only."""
    def __init__(self,state,config,*,notify=None,clock=None,monotonic=None,delay=10):
        self.state=state; self.config=config; self.notify=notify
        self.clock=clock or time.time
        self.monotonic=monotonic or (time.monotonic if clock is None else clock)
        self._anchor_mono=self.monotonic(); self._anchor_utc=int(self.clock()*1000)
        saved=state.data.get('watchClock') or {}
        elapsed=self._anchor_mono-saved.get('monotonic',self._anchor_mono+1)
        if 0<=elapsed<31536000:
            self._anchor_utc=max(self._anchor_utc,int(saved['utc']+elapsed*1000))
        elif saved:
            # After a reboot or an uncertain clock domain, never move effective
            # time backwards and give an old failure deadline a fresh budget.
            self._anchor_utc=max(self._anchor_utc,saved['utc'])
        self.delay=int(delay*1000); self.revision=state.data.get('watchRevision',-1)
        self._now()
        with state.lock: state.save()

    def _now(self):
        tick=self.monotonic()
        # macOS monotonic time excludes suspend. UTC must also advance the
        # effective clock so a stale proof cannot survive hours of sleep.
        value=max(self._anchor_utc+max(0,tick-self._anchor_mono)*1000,self.clock()*1000)
        self._anchor_utc=value; self._anchor_mono=tick
        now=int(value)
        with self.state.lock:
            self.state.data['watchClock']={'utc':now,'monotonic':tick}
        return now

    def _deliver(self,title,detail):
        try:
            (self.notify or os_notice)(title,detail)
            status='submitted'  # Process acceptance does not prove OS permission.
        except Exception:
            status='failed'
        with self.state.lock:
            result={'status':status,'at':self._now()}
            if status=='failed': result['error']='os_notification_failed'
            self.state.data['notificationStatus']=result
            results=self.state.data.setdefault('notificationResults',[])
            results.append(result); del results[:-8]
            self.state.save()

    def snapshot(self,snapshot):
        revision=snapshot.get('revision')
        if type(revision) is not int or revision<self.revision: return
        self.revision=revision
        now=self._now()
        own={i.get('itemId'):i for i in snapshot.get('items',[]) if i.get('instanceId')==self.config['instanceId']}
        service=next((s for s in snapshot.get('services',[]) if s.get('id')==self.config['serviceId']),{})
        display=snapshot.get('displaying') or {}
        with self.state.lock:
            for rec in self.state.records.values():
                item=own.get(rec['itemId']); disabled=service.get('config',{}).get('enabled') is False
                if disabled or item and item.get('state')=='paused':
                    rec['suppressed']=True; continue
                rec['suppressed']=False
                if snapshot.get('health',{}).get('status') in ('blocked','offline'):
                    rec['deadline']=min(rec.get('deadline',now),now)
                if not item:
                    if rec.get('proofUntil',0)>now:
                        rec['deadline']=min(rec.get('deadline',now+self.delay),now+self.delay)
                        rec['proofUntil']=0
                    continue
                key=item.get('itemKey'); generation=snapshot.get('generation')
                valid=0
                healthy=snapshot.get('health',{}).get('status')=='healthy'
                confirmation=display.get('confirmedValidUntil',0)
                # The displayed owner alone has no content version. Require its
                # frozen coverageProof too, so an unacknowledged update cannot
                # borrow a previous version's device acknowledgment.
                for name in ('queueProof','coverageProof'):
                    proof=item.get(name) or {}; controller=proof.get('controller') or {}
                    until=proof.get('validUntil',0)
                    if (healthy and proof.get('revision')==revision and proof.get('itemKey')==key
                        and controller.get('itemKey')==display.get('itemKey')
                        and controller.get('generation')==display.get('generation')==generation
                        and item.get('version')==rec['version']
                        and (name!='coverageProof' or proof.get('version')==rec['version'])
                        and type(until) in (int,float) and math.isfinite(until)
                        and type(confirmation) in (int,float) and until<=confirmation):
                        valid=max(valid,until)
                if (type(valid) in (int,float) and math.isfinite(valid) and now<valid<=now+86400000
                        and (revision>rec.get('proofRevision',-1) or valid<=rec.get('proofUntil',0))):
                    # Identical SSE/heartbeat copies cannot move this deadline.
                    rec['deadline']=max(rec.get('deadline',0),int(valid)+self.delay)
                    rec['proofUntil']=int(valid); rec['proofRevision']=revision
                elif rec.get('proofUntil',0)>now:
                    rec['deadline']=min(rec.get('deadline',now+self.delay),now+self.delay)
                    rec['proofUntil']=0
            self.state.data['watchRevision']=revision
            self.state.save()

    def check(self):
        due=[]; now=self._now()
        with self.state.lock:
            for rec in self.state.records.values():
                if (rec.get('level')=='urgent' and not any(rec.get(k) for k in ('notified','cleared','suppressed'))
                        and (not rec.get('tombstone') or rec.get('fallbackPending'))
                        and now>=rec.get('deadline',rec['firstRecognizedAt']+self.delay)):
                    rec['notified']=True; due.append((rec.get('title','Urgent notification'),rec.get('detail','')))
                    rec['fallbackPending']=False
                    if rec.get('tombstone'): self.state.compact(rec)
            if due: self.state.save()  # Dedupe before invoking the OS.
        for title,detail in due:
            if self.notify is not None: self._deliver(title,detail)
            else: threading.Thread(target=self._deliver,args=(title,detail),name='busy-cloud-os-notice',daemon=True).start()


def os_notice(title,detail):
    # Text is JSON escaped in stdin; never shell code, argv, a token or a remote URL.
    script='display notification '+json.dumps(str(detail)[:500],ensure_ascii=False)+' with title '+json.dumps(str(title)[:160],ensure_ascii=False)
    result=subprocess.run(['/usr/bin/osascript','-'],input=script,text=True,capture_output=True,timeout=5)
    if result.returncode: raise CloudError('os_notification_failed')


class Actions:
    def __init__(self,state,config,*,clock=None):
        self.state=state; self.config=config; self.clock=clock or time.time; self.callbacks={}
        with state.lock:
            for action in state.data['actions'].values():
                if action['status']=='running':
                    action['status']='unknown'; action['sent']=False; action['outbox']=['unknown']
            state.save()

    def accept(self,snapshot):
        for action in snapshot.get('actions',[]):
            ident=action.get('id')
            if (action.get('status')!='pending' or action.get('serviceId')!=self.config['serviceId']
                    or action.get('instanceId')!=self.config['instanceId']): continue
            with self.state.lock:
                if ident in self.state.data['actions']: continue
                if len(self.state.data['actions'])>=LOCAL_ACTIONS: raise CloudError('local_action_capacity')
                item=next((i for i in snapshot.get('items',[]) if i.get('itemId')==action.get('itemId')),None)
                callback=self.callbacks.get(action.get('itemId'),{}).get(action.get('actionKey'))
                record=next((r for r in self.state.records.values() if r['itemId']==action.get('itemId')),None)
                valid=(record is not None and not record.get('cleared') and not record.get('tombstone')
                       and not record.get('sourceUnknown')
                       and action.get('version')==record['version']==(item or {}).get('version')
                       and action.get('businessId')==record.get('businessId') and callback is not None and item is not None and action.get('itemKey')==item.get('itemKey')
                       and action.get('generation')==snapshot.get('generation')
                       and action.get('itemKey')==snapshot.get('selected')
                       and action.get('actionKey') in item.get('actionKeys',[])
                       and action.get('expiresAt',0)>self.clock()*1000)
                if not valid:
                    self.state.data['actions'][ident]={'status':'failed','sent':False,'outbox':['failed']}
                    self.state.save(); continue
                self.state.data['actions'][ident]={'status':'running','sent':False,'outbox':['running']}
                self.state.save()  # Never repeat even if the side effect crashes this process.
            try: callback(); result='succeeded'
            except Exception: result='failed'
            with self.state.lock:
                record=self.state.data['actions'][ident]
                record.update(status=result,sent=False); record.setdefault('outbox',[]).append(result); self.state.save()


class Producer:
    """Background worker with durable retries; sampling methods never perform HTTP."""
    def __init__(self,runtime,config,transport,*,clock=None,notify=None):
        self.config=config; self.http=transport; self.clock=clock or time.time
        fallback=validated_fallback(config.get('fallbackSeconds',10))
        self.state=State(Path(runtime)/('cloud-'+config['role']+'-state.json'),clock=self.clock,fallback_seconds=fallback)
        with self.state.lock:
            if self.state.data.get('epoch',config['epoch'])!=config['epoch']:
                self.state.records.clear(); self.state.data['ends']={}; self.state.data['actions']={}; self.state.data['inputs']={}
                for asset in self.state.data['assets'].values():asset.pop('uploadedAt',None)
            self.state.data['epoch']=config['epoch']; self.state.save()
        self.guard=Watchdog(self.state,config,clock=self.clock,monotonic=time.monotonic if clock is None else clock,notify=notify,delay=fallback)
        self.actions=Actions(self.state,config,clock=self.clock)
        self.queue=ServiceQueue(self.state,config,self.guard,clock=self.clock,error_type=CloudError)
        self._stop=threading.Event()
        now=self.clock()
        self._threads=[]
        # Cache receipts are an optimization, never display/admission proof.
        # Capacity eviction is repaired by the existing exact-body403 retry.
        self._assets={digest:asset['uploadedAt'] for digest,asset in self.state.data['assets'].items()
                      if type(asset.get('uploadedAt')) in (int,float) and 0<=now-asset['uploadedAt']<1800}
        self._heart=0; self._presence_at=0; self.heartbeat_error=None; self.error=None; self.on_admitted=None; self.on_tombstone=None
        self._io_lock=threading.Lock()
        self._request_lock=threading.Lock(); self._request_history=deque(maxlen=64); self._request_pending={}

    # Compatibility facade for existing adapters. Queue state has one owner;
    # lifecycle code consumes only accept/snapshot_due, not these internals.
    @property
    def snapshot(self): return self.queue.snapshot

    @snapshot.setter
    def snapshot(self,value): self.queue.snapshot=value

    @property
    def _snapshot_lock(self): return self.queue._snapshot_lock

    @property
    def on_admitted(self): return self.queue.on_admitted

    @on_admitted.setter
    def on_admitted(self,value): self.queue.on_admitted=value

    @property
    def on_tombstone(self): return self.queue.on_tombstone

    @on_tombstone.setter
    def on_tombstone(self,value): self.queue.on_tombstone=value

    def accept(self,snapshot): self.queue.accept(snapshot)

    def _snapshot_due(self): return self.queue.snapshot_due()

    def asset(self,name,data):
        suffix=Path(name).suffix.lstrip('.').lower()
        if suffix not in ('png','gif','webp','anim') or len(data)>262144: raise CloudError('invalid_asset')
        if suffix=='anim' and data.startswith(b'bicycle0'):
            from .native import compact_native_asset
            try:data=compact_native_asset(data)
            except ValueError:pass  # Preserve existing handling of other native variants.
        digest=hashlib.sha256(data).hexdigest()
        with self.state.lock:
            if digest not in self.state.data['assets']:
                self.state.data['assets'][digest]={'hash':digest,'type':suffix,'data':base64.b64encode(data).decode(),'usedAt':self.clock()}
            else:
                if self.clock()-self.state.data['assets'][digest].get('usedAt',0)<30: return digest
                self.state.data['assets'][digest]['usedAt']=self.clock()
            try: self.state.trim_assets(protect=digest)
            except CloudError:
                self.state.data['assets'].pop(digest,None); raise
            for old in set(self._assets)-self.state.data['assets'].keys(): self._assets.pop(old,None)
            self.state.save()
        return digest

    def input(self):
        with self._snapshot_lock: generation=self.snapshot.get('generation')
        if type(generation) is not int: return
        with self.state.lock:
            if len(self.state.data['inputs'])>=LOCAL_INPUTS: raise CloudError('local_input_capacity')
            event=str(uuid.uuid4()); self.state.data['inputs'][event]={'eventId':event,'instanceId':self.config['instanceId'],
                                    'generation':generation,'button':'start_pause'}
            self.state.save()

    def start(self):
        for name,target in (('publisher',self._run),('sse',self._events),('watchdog',self._watchdog),('actions',self._actions),('heartbeat',self._heartbeat_run),('snapshot-poll',self._poll_snapshots)):
            thread=threading.Thread(target=target,name='busy-cloud-'+name+'-'+self.config['role'],daemon=True)
            self._threads.append(thread); thread.start()

    def _watchdog(self):
        while not self._stop.wait(.2): self.guard.check()

    def _actions(self):
        while not self._stop.wait(.2):
            snapshot=self.queue.read_snapshot()
            try: self.actions.accept(snapshot)
            except CloudError as error: self.error=error.code

    @staticmethod
    def _terminal_connection_error(error):
        return isinstance(error,CloudError) and error.code=='unauthorized' and error.status in (401,403)

    def _connection_error(self,error):
        self.error=error.code if isinstance(error,CloudError) else 'sse_unavailable'

    def _events(self):
        SnapshotStreamChannel(stop=self._stop,connect=self.http.events,deliver=self.accept,
            errors=(CloudError,OSError,ValueError),terminal=self._terminal_connection_error,
            on_error=self._connection_error).run()

    def _poll_snapshots(self):
        # Downlink fallback cannot queue behind an upstream publish or asset upload.
        # accept owns revision/freshness/queue semantics; this lane only transports.
        def poll():
            if self._snapshot_due():self._response('GET','/api/snapshot')
        PeriodicChannel(stop=self._stop,operation=poll,errors=(CloudError,),
            terminal=self._terminal_connection_error,on_error=self._connection_error).run()

    def request_diagnostics(self):
        """Bounded timing metadata only: no URLs, IDs, hashes or content."""
        with self._request_lock:
            pending=copy.deepcopy(min(self._request_pending.values(),key=lambda row:row['startedMono'],default=None))
            if pending:pending['elapsedMs']=round((time.monotonic()-pending.pop('startedMono'))*1000,2)
            return {'inFlight':pending,'recent':copy.deepcopy(list(self._request_history))}

    def _request(self,method,path,body=None):
        endpoint=path if path in ('/api/snapshot','/api/assets','/api/publish','/api/update','/api/heartbeat','/api/input','/api/end','/api/withdraw') else '/api/other'
        row={'method':method if method in ('GET','POST') else 'other','endpoint':endpoint,
             'startedAtMs':round(self.clock()*1000),'phase':'http'}
        if endpoint=='/api/assets' and isinstance(body,dict) and isinstance(body.get('data'),str):
            encoded=body['data'];row['assetBytes']=len(encoded)*3//4-(len(encoded)-len(encoded.rstrip('=')))
        started=time.monotonic()
        token=object()
        with self._request_lock:self._request_pending[token]={**row,'startedMono':started}
        try:
            response=self.http.request(method,path,body);row['ok']=True;return response
        except Exception:
            row['ok']=False;raise
        finally:
            row['elapsedMs']=round((time.monotonic()-started)*1000,2)
            with self._request_lock:
                self._request_history.append(row);self._request_pending.pop(token,None)

    def _response(self,method,path,body=None):
        response=self._request(method,path,body)
        snapshot=response.get('snapshot',response)
        if snapshot.get('protocol')==1:
            started=time.monotonic();row={'phase':'accept','startedAtMs':round(self.clock()*1000)}
            token=object()
            with self._request_lock:self._request_pending[token]={**row,'startedMono':started}
            try:self.accept(snapshot)
            finally:
                row['elapsedMs']=round((time.monotonic()-started)*1000,2)
                with self._request_lock:
                    self._request_history.append(row);self._request_pending.pop(token,None)
        return response

    def _upload_assets(self,hashes,asset_bodies,*,force=False):
        for digest in hashes:
            if not force and 0<=self.clock()-self._assets.get(digest,-float('inf'))<1800: continue
            asset=asset_bodies.get(digest)
            if asset is None: raise CloudError('local_asset_unavailable')
            result=self._request('POST','/api/assets',asset)
            if result.get('hash')!=digest: raise CloudError('asset_hash_mismatch')
            with self.state.lock:
                self._assets[digest]=self.clock()
                cached=self.state.data['assets'].get(digest)
                if cached is not None:
                    # Persist with the next normal state save. A crash before
                    # that save merely reuploads; no new I/O lock is introduced.
                    cached['uploadedAt']=self._assets[digest]
                if len(self._assets)>LOCAL_ASSET_COUNT:
                    del self._assets[min(self._assets,key=self._assets.get)]

    def _content(self,path,body,hashes,asset_bodies):
        try: return self._response('POST',path,body)
        except CloudError as error:
            if error.code!='asset_not_authorized': raise
            with self.state.lock:
                for digest in hashes:
                    self._assets.pop(digest,None)
                    cached=self.state.data['assets'].get(digest)
                    if cached is not None:cached.pop('uploadedAt',None)
            self._upload_assets(hashes,asset_bodies,force=True)
            # At most one immediate repair. Another eviction goes through the
            # normal bounded worker backoff, with the exact frozen body retained.
            return self._response('POST',path,body)

    def flush(self):
        identity={'instanceId':self.config['instanceId'],'epoch':self.config['epoch']}
        with self.state.lock:
            records=copy.deepcopy(list(self.state.records.values()))
            # Copy immutable payloads in the same critical section as records.
            # A collector may replace a scene and reclaim its old LRU hashes
            # as soon as this lock is released. One sequential flush retains at
            # most the bounded local cache (128 assets / 8 MiB) until return,
            # including bytes needed by its exact frozen-body repair retry.
            asset_bodies={digest:{k:asset[k] for k in ('hash','type','data')}
                          for digest,asset in self.state.data['assets'].items()}
            results=copy.deepcopy(self.state.data['actions']); inputs=copy.deepcopy(self.state.data['inputs'])
            ends=copy.deepcopy(self.state.data['ends'])
        for ident,body in ends.items():
            self._response('POST','/api/withdraw' if body.get('withdraw') else '/api/end',{**identity,**{k:v for k,v in body.items() if k!='withdraw'}})
            with self.state.lock: self.state.data['ends'].pop(ident,None); self.state.save()
        for rec in records:
            if rec.get('tombstone'): continue
            if rec.get('cleared') or rec.get('handoverPendingSource') or rec.get('renderPending') or not isinstance(rec.get('scene'),dict) or rec['acked']>=rec['version']: continue
            frozen=rec.get('publishBody')
            if frozen and frozen['validUntil']<=self.clock()*1000:
                rec=self.queue.recover_expired_publish(rec)
                if rec is None:continue
            scene=rec['scene']
            hashes={e['assetHash'] for c in scene.get('commands',[]) for e in c['elements'] if 'assetHash' in e}
            hashes|={e['assetHash'] for e in rec.get('update',[]) if 'assetHash' in e}
            self._upload_assets(hashes,asset_bodies)
            body={**identity,**{k:rec[k] for k in ('itemId','version','firstRecognizedAt','kind','level','title','detail','scene')}}
            body['exit']=rec.get('exit','source' if rec['kind']=='agent' or rec['level']=='urgent' else 'finite')
            for field in ('groupKey','actionKeys','businessId','app'):
                if field in rec: body[field]=rec[field]
            body['validUntil']=rec['lastSourceAt']+60000
            with self.state.lock:
                live=next((r for r in self.state.records.values() if r['itemId']==rec['itemId']),None)
                if live is None or live['version']!=rec['version']: continue
                if 'publishBody' not in live:
                    live['publishBody']=copy.deepcopy(body); self.state.save()
                body=copy.deepcopy(live['publishBody'])
            # An update belongs to the selected generation only. A full same-item
            # publish remains the recovery route when it has been preempted.
            with self._snapshot_lock: snap=copy.deepcopy(self.snapshot)
            item=next((i for i in snap.get('items',[]) if i.get('itemId')==rec['itemId']),{})
            if (rec.get('update') and snap.get('selected')==item.get('itemKey') and item
                    and rec.get('app')==item.get('app')):
                with self.state.lock:
                    live=next((r for r in self.state.records.values() if r['itemId']==rec['itemId']),None)
                    if live is None or live['version']!=rec['version'] or live.get('cleared') or live.get('tombstone'): continue
                    if 'updateBody' not in live:
                        live['updateBody']={**identity,'itemId':rec['itemId'],'version':rec['version'],
                                            'generation':snap['generation'],'elements':rec['update'],'scene':rec['scene']}
                        self.state.save()
                    update=copy.deepcopy(live['updateBody'])
                if update['generation']!=snap['generation']:
                    response=self._content('/api/publish',body,hashes,asset_bodies)
                else:
                    response=self._content('/api/update',update,hashes,asset_bodies)
            else: response=self._content('/api/publish',body,hashes,asset_bodies)
            self.queue.acknowledge(rec['itemId'],rec['version'])
        now=self.clock()
        if now-self._heart>=5:
            # Each source has a bounded freshness window based on its next
            # expected poll; a hung/failed poll cannot renew cached state forever.
            renew={}
            for r in records:
                if any(r.get(k) for k in ('cleared','tombstone','sourceUnknown')) or r['acked']<=0: continue
                fresh=r.get('sourceFreshUntil',r['lastSourceAt']+45000)
                if fresh<=now*1000: continue
                until=min(int(now*1000)+60000,fresh)
                renew.setdefault(until,[]).append(r['itemId'])
            # Idle publishers still report their connection. An empty list
            # renews no occurrence and cannot revive stale or ended work.
            if not renew: renew[int(now*1000)+60000]=[]
            for until,alive in renew.items():
                self._response('POST','/api/heartbeat',{**identity,'itemIds':alive,'validUntil':until})
            self._heart=now
        for ident,result in results.items():
            if result['sent']: continue
            for status in result.get('outbox',[result['status']]):
                try:
                    self._response('POST','/api/actions/'+ident+'/result',{'instanceId':identity['instanceId'],'status':status})
                except CloudError as error:
                    if error.status not in (404,409): raise
                    # An expired pending action cannot begin running. Terminal
                    # late results may still resolve authoritative unknowns.
                with self.state.lock:
                    live=self.state.data['actions'][ident]
                    if live.get('outbox') and live['outbox'][0]==status: live['outbox'].pop(0)
                    live['sent']=not live.get('outbox'); self.state.save()
        for ident,body in inputs.items():
            try: self._response('POST','/api/input',body)
            except CloudError as error:
                if error.status!=409 and error.code!='input_forbidden': raise
            with self.state.lock: self.state.data['inputs'].pop(ident,None); self.state.save()

    def maintain_presence(self):
        """Transport liveness only: never renew business items or run callbacks.

        Keep occurrence renewal in the ordered outbox lane. A delayed concurrent
        renewal can otherwise shorten a newer publish's validUntil on the server.
        Snapshot reconciliation remains owned by SSE and the normal poll fallback.
        """
        now=self.clock()
        if now-self._presence_at<5: return
        identity={'instanceId':self.config['instanceId'],'epoch':self.config['epoch']}
        self._request('POST','/api/heartbeat',
                      {**identity,'itemIds':[],'validUntil':int(now*1000)+60000})
        self._presence_at=now

    def _heartbeat_run(self):
        PeriodicChannel(stop=self._stop,operation=self.maintain_presence,errors=(CloudError,),
            terminal=self._terminal_connection_error,
            on_error=lambda error:setattr(self,'heartbeat_error',error.code),
            on_success=lambda:setattr(self,'heartbeat_error',None)).run()

    def _run(self):
        # Upstream content remains ordered. Retry/stop never own durable outbox
        # state, item identity or acknowledgement; only business responses do.
        def publish():
            with self._io_lock:self.flush()
        PeriodicChannel(stop=self._stop,operation=publish,errors=(CloudError,),
            terminal=self._terminal_connection_error,on_error=self._connection_error,
            on_success=lambda:setattr(self,'error',None)).run()

    def stop(self):
        # A process restart must retain occurrence identity, snooze and deadline.
        # Source-clear and /end are reserved for confirmed source resolution.
        self._stop.set()
        for thread in self._threads: thread.join(timeout=.1)
