"""Adapt existing native renderers and raw notification sources to cloud scenes."""
import copy
import json
import io
from PIL import Image
import threading

from busybar_agents.motion import MotionDirector, visual_state
from busybar_agents.motion_assets import REGIONS, FPS
from busybar_notifier.presenter import NotificationPresenter
from busybar_notifier.display import entrance_seconds
from busybar_notifier.model import status_color


class Capture:
    """The existing renderers draw here; only a Producer can perform network I/O."""
    def __init__(self,producer):
        self.producer=producer; self.assets={}; self.asset_data={}; self.draws=[]
    def upload_asset(self,name,data):
        self.assets[name]=self.producer.asset(name,data); self.asset_data[name]=data
    def convert(self,elements):
        result=[]
        for element in elements:
            value={k:copy.deepcopy(v) for k,v in element.items() if k not in ('timeout','display_until','application_name')}
            path=value.pop('path',None)
            if path is not None:
                if self.assets[path] not in self.producer.state.data['assets']:
                    self.assets[path]=self.producer.asset(path,self.asset_data[path])
                value['assetHash']=self.assets[path]
            if value['type']=='xpmbitmap' and len(json.dumps(value))>8192:
                # The existing back display bitmap exceeds the protocol's 8KiB
                # element bound. Encode the same quantized pixels as PNG.
                lines=value.pop('data').splitlines()
                width,height,count,chars=map(int,lines[1].split())
                palette={line[:chars]:tuple(bytes.fromhex(line.split(' c #',1)[1])) for line in lines[2:2+count]}
                image=Image.new('RGB',(width,height))
                image.putdata([palette[row[x:x+chars]] for row in lines[2+count:2+count+height] for x in range(0,width*chars,chars)])
                output=io.BytesIO(); image.save(output,format='PNG')
                value.update(type='image',assetHash=self.producer.asset('bitmap.png',output.getvalue()))
            result.append(value)
        return result
    def draw(self,body):
        self.draws.append(self.convert(body['elements'])); return True
    def clear(self): pass


def notification_scene(producer,item,*,reduced=False):
    """Capture the complete entrance, early detail and final settled view."""
    tick=[0.0]; capture=Capture(producer)
    presenter=NotificationPresenter(capture,reduced=reduced,clock=lambda:tick[0])
    presenter.start(item)
    commands=[{'offsetMs':0,'elements':capture.draws[-1]}]
    duration=0 if reduced else round(entrance_seconds(item)*1000)
    if not reduced:
        capture.draws.clear(); tick[0]=.3; presenter.advance()
        for elements in capture.draws: commands.append({'offsetMs':300,'elements':elements})
        capture.draws.clear(); tick[0]=duration/1000+.001; presenter.advance()
        for elements in capture.draws: commands.append({'offsetMs':duration,'elements':elements})
    color=status_color(item.level,item.accent)
    return {'entryDurationMs':duration,'commands':commands,'ledColor':'#{:02X}{:02X}{:02X}FF'.format(*color)}


class CloudQueue:
    """Queue-compatible raw publisher: no local winner, grouping or snooze policy."""
    def __init__(self,producer,*,reduced=False):
        self.producer=producer; self.reduced=reduced; self.on_shown=None
        self._items={}; self._lock=threading.RLock()
        producer.on_admitted=self._shown
        self._prior_tombstone=producer.on_tombstone
        producer.on_tombstone=self._terminal

    def _prune(self):
        with self.producer.state.lock:
            live={record['itemId'] for record in self.producer.state.records.values()
                  if not record.get('cleared') and not record.get('tombstone')}
        for key in set(self._items)-live: self._items.pop(key,None)
        for key in set(self.producer.actions.callbacks)-live: self.producer.actions.callbacks.pop(key,None)

    def _terminal(self,item_id,reason):
        with self._lock: self._prune()
        if self._prior_tombstone: self._prior_tombstone(item_id,reason)

    def _shown(self,item_id):
        with self._lock: item=self._items.get(item_id)
        if item is not None and self.on_shown:
            self.on_shown(item); return True
        return False

    def _put(self,item,kind,source):
        key=source+':'+item.id
        existing=self.producer.state.records.get(key)
        # A heartbeat never turns a tombstoned occurrence into a new event.
        if existing and existing.get('tombstone') and not existing.get('cleared'): return
        content={'app':item.app,'kind':kind,'level':item.level,'title':item.title[:256],'detail':item.detail[:2048],
                 'businessId':item.id[:256],'actionKeys':['primary'] if item.primary else []}
        if item.group: content['groupKey']=item.group[:128]
        # A source callback object can change without a visual change.
        fingerprint=json.dumps(content,sort_keys=True)
        if (existing and existing.get('localFingerprint')==fingerprint and not existing.get('cleared')
                and not existing.get('renderPending')):
            scene=existing['scene']
        else:
            # Recognition and the urgent deadline must survive rendering or
            # asset-capacity failure. This placeholder is never sent to cloud.
            pending=self.producer.state.recognize(key,scene=None,renderPending=True,**content)
            if pending is None: return
            scene=notification_scene(self.producer,item,reduced=self.reduced)
        record=self.producer.state.recognize(key,scene=scene,renderPending=False,**content)
        if record:
            with self.producer.state.lock:
                self.producer.state.records[key]['localFingerprint']=fingerprint; self.producer.state.save()
            self._items[record['itemId']]=item
            self.producer.actions.callbacks[record['itemId']]={'primary':item.primary} if item.primary else {}
            self._prune()

    def set_state(self,source,notifications):
        with self._lock:
            keys={source+':'+item.id for item in notifications}
            for key,record in list(self.producer.state.records.items()):
                if key.startswith(source+':') and record.get('kind')=='condition' and key not in keys:
                    self.producer.state.clear(key)
                    self.producer.actions.callbacks.pop(record['itemId'],None)
            for item in notifications: self._put(item,'condition',source)
            self._prune()

    def push(self,notifications):
        with self._lock:
            for item in notifications: self._put(item,'event',item.source or item.app)
            self._prune()

    def source_ok(self,source,every):
        now=int(self.producer.clock()*1000)
        with self.producer.state.lock:
            for key,record in self.producer.state.records.items():
                if key.startswith(source+':') and not record.get('cleared'):
                    record['lastSourceAt']=now
                    record['sourceUnknown']=False
                    record['sourceFreshUntil']=now+round(max(60,min(float(every)+30,3600))*1000)
            self.producer.state.save()

    def source_error(self,source,error):
        # The last value is uncertain, not authoritatively clear. Stop renewing
        # its lease; the independent urgent deadline remains in effect.
        self.producer.state.unknown(source)


class AgentRenderer:
    """Use MotionDirector unchanged; publish full recovery and native deltas."""
    def __init__(self,producer,*,reduced=False,clock=None):
        self.producer=producer; self.reduced=reduced
        self.capture=Capture(producer); self.motion=MotionDirector(self.capture,reduced=reduced,clock=clock)
        self._task=None; self._args=None; self._last_elements={}
        previous=producer.state.records.get('agent') or {}
        self._turn=tuple(previous['agentTurn']) if 'agentTurn' in previous else None

    @property
    def due(self): return self.motion.due
    @property
    def pending(self): return self.motion.pending

    def _save(self):
        if self._args is None: return
        app=getattr(self._task,'source',None) or 'codex'
        with self.producer.state.lock:
            previous=copy.deepcopy(self.producer.state.records.get('agent') or {})
        metadata_changed=bool(previous) and previous.get('app')!=app
        if not self.capture.draws and not metadata_changed: return
        # Fresh director provides a complete recovery entrance even when the
        # ongoing director emitted only a mask or numeric roll.
        complete=Capture(self.producer)
        fresh=MotionDirector(complete,reduced=self.reduced,clock=lambda:0)
        fresh.show(*self._args)
        scene={'entryDurationMs':0 if self.reduced else round(REGIONS['view'][2]/FPS*1000),
               'commands':[{'offsetMs':0,'elements':complete.draws[-1]}]}
        elements={e['id']:e for draw in self.capture.draws for e in draw}
        self.capture.draws.clear()
        changed={key:value for key,value in elements.items() if self._last_elements.get(key)!=value}
        self._last_elements.update(elements)
        if not changed and not metadata_changed: return
        state=visual_state(self._task)
        content={'app':app,'kind':'event' if state=='standby' else 'agent','level':'info',
                 'title':'Agent '+state,'detail':getattr(self._task,'project','')[:2048],
                 'scene':scene,'actionKeys':[], 'frameSignature':json.dumps(changed,sort_keys=True), 'agentTurn':self._turn}
        record=self.producer.state.recognize('agent',**content)
        if record:
            with self.producer.state.lock:
                live=self.producer.state.records['agent']
                if live['acked'] and live['version']>live['acked']:
                    # Merge pending deltas so a slow publisher cannot lose a
                    # motion update produced between clock samples.
                    pending={e['id']:e for e in previous.get('update',[]) if previous.get('itemId')==live['itemId']}
                    pending.update(changed); live['update']=list(pending.values())
                self.producer.state.save()

    def show(self,task,now,count=1,rates=None):
        state=visual_state(task)
        turn=(getattr(task,'session_id',None),getattr(task,'turn_id',None),state=='standby')
        if task is None and self._turn is not None and self._turn[2]: turn=self._turn
        if self._turn is not None and turn!=self._turn:
            # New task/standby is a new finite occurrence. Updates within a turn
            # keep identity and do not restart native animations or visible time.
            self.producer.state.clear('agent')
        self._turn=turn; self._task=task; self._args=(task,now,count,rates)
        self.motion.show(task,now,count,rates); self._save()
        with self.producer.state.lock:
            record=self.producer.state.records.get('agent')
            if record and not record.get('cleared') and not record.get('tombstone'):
                record['lastSourceAt']=int(self.producer.clock()*1000)
                self.producer.state.save()

    def advance(self): self.motion.advance(); self._save()
    def hide(self): self.producer.state.clear('agent'); self.motion.invalidate()
