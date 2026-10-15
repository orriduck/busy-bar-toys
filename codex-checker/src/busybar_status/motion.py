"""Non-blocking transitions. The device plays frames; the Mac sends targets."""
from dataclasses import dataclass
import time
from PIL import Image

from .animation import glow_frame
from .display import (ICON_X, TEXT_X, COLORS, clock_font, clock_text, make_payload,
                      rate_left, to_xpm, total_rate_text)
from .motion_assets import (FPS, PREFIX, REGIONS, bar_name, build_assets, fade_name)


def visual_state(task):
    state=task.state if task else 'idle'
    return 'standby' if state in ('idle','done','stopped') else state


@dataclass(frozen=True)
class Presentation:
    task: object
    now: float
    count: int
    rates: object

    @property
    def state(self):return visual_state(self.task)
    @property
    def source(self):return 'dots' if self.task and self.task.source=='dots' else 'chatgpt'
    @property
    def clock(self):return clock_text(self.now)
    @property
    def rate(self):return total_rate_text(self.rates)


class MotionDirector:
    def __init__(self,client,*,reduced=False,clock=None):
        self.client=client;self.reduced=reduced;self.clock=clock or time.monotonic
        self.current=None;self.target=None;self.visible=False
        self._phase=None;self._regions=[];self._deadline=0;self._settles_at=0;self._lease_until=0
        self._uploaded=set()

    @property
    def pending(self):return self._phase is not None
    @property
    def due(self):return self.pending and self.clock()>=self._deadline
    @property
    def standby_visible(self):
        return (self.visible and self.current is not None and self.current.state=='standby'
                and self._phase!='exit' and self.clock()>=self._settles_at)

    def prepare(self):
        if self.reduced:return
        for name,data in build_assets().items():
            if name not in self._uploaded:
                self.client.upload_asset(name,data)
                self._uploaded.add(name)

    def _mask(self,region,reveal):
        x,y={'view':(0,0),'bar':(0,0),'icon':(ICON_X,1),'rate':(TEXT_X,10)}[region]
        return {'id':'motion-'+region,'type':'animation','display':'front',
                'x':x,'y':y,'z_index':20 if region=='view' else 10,
                'timeout':1 if reveal else 15,'path':fade_name(region,reveal),
                'loop':False,'await_previous_end':False}

    @staticmethod
    def _payload(elements):
        return {'application_name':'ai-status','priority':50,'elements':elements}

    def _rolls(self,target,regions):
        if self.current is None or 'view' in regions:return []
        result=[]
        pairs=[]
        if self.current.clock!=target.clock:
            for i,(old,new) in enumerate(zip(self.current.clock,target.clock)):
                x=TEXT_X+round(clock_font().getlength(target.clock[:i]))
                pairs.append(('clock',i,old,new,x,1))
        if 'rate' not in regions and self.current.rate!=target.rate:
            x=rate_left(target.rate)+10
            for i,(old,new) in enumerate(zip(self.current.rate,target.rate)):
                pairs.append(('rate',i,old,new,x+i*4,10))
        for kind,i,old,new,x,y in pairs:
            if old==new or old not in '0123456789' or new not in '0123456789':continue
            result.append({'id':f'roll-{kind}-{i}','type':'animation','display':'front',
                           'x':x,'y':y,'z_index':5,'timeout':1,
                           'path':f'{PREFIX}-{kind}.anim','section':old+'-'+new,
                           'loop':False,'await_previous_end':False})
        return result

    def _commit(self,target,regions):
        payload=make_payload(target.task,target.now,target.count,target.rates)
        strip=next(e for e in payload['elements'] if e['id']=='thinking')
        if self.reduced:
            if target.state=='working':
                color=tuple(bytes.fromhex(COLORS['working'][1:]))
                image=Image.frombytes('RGB',(4,16),glow_frame(0,color,moving=False))
                strip.update(type='xpmbitmap',data=to_xpm(image))
                for field in ('path','loop','await_previous_end','section'):strip.pop(field,None)
        else:
            strip.update(type='animation',path=bar_name(target.state),section='default',
                         loop=True,await_previous_end=target.state=='working')
            strip.pop('data',None)
            payload['elements']+=self._rolls(target,regions)
            payload['elements']+=[self._mask(region,True) for region in regions]
        if not self.client.draw(payload):return False
        self.current=target;self.visible=True
        self._lease_until=self.clock()+15
        self._settles_at=max(self._settles_at,self.clock()+max(
            (REGIONS[r][2]/FPS for r in regions),default=0))
        return True

    def _changes(self,target):
        regions=[]
        if self.current.state!=target.state:regions.append('bar')
        if self.current.source!=target.source:regions.append('icon')
        old,new=self.current.rate,target.rate
        old_pattern=[(i,c) for i,c in enumerate(old) if not c.isdigit()]
        new_pattern=[(i,c) for i,c in enumerate(new) if not c.isdigit()]
        if old!=new and (len(old)!=len(new) or old_pattern!=new_pattern):regions.append('rate')
        return regions

    def show(self,task,now,count=1,rates=None):
        target=Presentation(task,now,count,rates)
        if self.reduced:return self._commit(target,[])
        self.prepare()
        if self.visible and self.clock()>=self._lease_until:
            self.visible=False;self.current=None;self.cancel()
        if self.pending:
            self.target=target
            if self._phase=='exit':
                self._phase='swap';self._regions=['view']
            elif 'view' not in self._regions:
                extra=[r for r in self._changes(target) if r not in self._regions]
                if extra:
                    sent_at=self.clock()
                    if not self.client.draw(self._payload([self._mask(r,False) for r in extra])):
                        self.cancel();return False
                    self._regions+=extra
                    self._deadline=max(self._deadline,sent_at+max(REGIONS[r][1]/FPS for r in extra))
            return False
        if not self.visible or self.current is None:
            return self._commit(target,['view'])
        regions=self._changes(target)
        if not regions:return self._commit(target,[])
        sent_at=self.clock()
        if not self.client.draw(self._payload([self._mask(r,False) for r in regions])):return False
        self.target=target;self._regions=regions;self._phase='swap'
        self._deadline=sent_at+max(REGIONS[r][1]/FPS for r in regions)
        return False

    def advance(self):
        if not self.due:return False
        if self._phase=='exit':
            self.client.clear();self.visible=False;self.current=None
            self.cancel();return True
        target,regions=self.target,self._regions
        result=self._commit(target,regions)
        self.cancel()
        return result

    def hide(self):
        if not self.visible:return True
        if self.reduced or self.clock()>=self._lease_until:
            self.client.clear();self.visible=False;self.current=None;self.cancel();return True
        if self._phase=='exit':return False
        sent_at=self.clock()
        if not self.client.draw(self._payload([self._mask('view',False)])):
            self.client.clear();self.visible=False;self.current=None;self.cancel();return True
        self.target=None;self._regions=['view'];self._phase='exit'
        self._deadline=sent_at+REGIONS['view'][1]/FPS
        return False

    def cancel(self):
        self._phase=None;self.target=None;self._regions=[]
