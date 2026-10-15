"""One finite aircraft alert, with a non-blocking hold and namespace handoff."""
import time
from PIL import Image
from busybar_shared.native import encode_sections,fade_asset
from .display import ENTRANCE_SECONDS,entrance_asset,payload


class AircraftPresenter:
    def __init__(self,client,*,reduced=False,clock=None):
        self.client=client;self.reduced=reduced;self.clock=clock or time.monotonic
        self.phase=None;self._hold_until=0;self._deadline=0;self._refresh_at=0
        self._nearby=None;self._demo=False;self._path=None;self._sequence=0;self._prepared=set()

    @property
    def active(self):return self.phase is not None

    def _prepare(self):
        assets={'adsbao-blank.anim':encode_sections((4,16),{'hold':[Image.new('RGB',(4,16))]}),
                'adsbao-transparent.anim':encode_sections((72,16),{'clear':[Image.new('RGBA',(72,16))]},rgba=True),
                'adsbao-out.anim':fade_asset((72,16),reveal=False,frames=6)}
        for name,data in assets.items():
            if name not in self._prepared:
                self.client.upload_asset(name,data);self._prepared.add(name)

    def start(self,nearby,*,demo=False):
        if self.active:return False
        self._sequence+=1
        path=f'adsbao-entry-v4-{self._sequence%2}.anim'
        if not self.reduced:
            self._prepare();self.client.upload_asset(path,entrance_asset(nearby))
        if not self.client.draw(payload(nearby,demo=demo,reduced=self.reduced,path=path)):return False
        self._nearby=nearby;self._demo=demo;self._path=path;self.phase='hold'
        self._hold_until=self.clock()+(0 if self.reduced else ENTRANCE_SECONDS)+10
        self._refresh_at=self.clock()+5
        return True

    def dismiss(self):
        if self.phase!='hold':return
        if self.reduced:self.phase='finished';return
        sent_at=self.clock()
        mask={'id':'motion-view','type':'animation','display':'front','x':0,'y':0,
              'z_index':40,'timeout':15,'path':'adsbao-out.anim','loop':False,'await_previous_end':False}
        if not self.client.draw({'application_name':'ai-status','priority':50,'elements':[mask]}):
            # Higher-priority device modes own the screen; release our state.
            self.phase='finished';return
        self.phase='exit';self._deadline=sent_at+.2

    def advance(self):
        """Return True once the coordinator must restore its latest base view."""
        if self.phase=='hold':
            if self.clock()>=self._hold_until:self.dismiss()
            elif self.clock()>=self._refresh_at:
                self.client.draw(payload(self._nearby,demo=self._demo,reduced=self.reduced,path=self._path))
                self._refresh_at=self.clock()+5
        if self.phase=='exit' and self.clock()>=self._deadline:
            transparent={'id':'plane-view','type':'animation','display':'front','x':0,'y':0,
                         'z_index':30,'timeout':1,'path':'adsbao-transparent.anim','loop':False,
                         'await_previous_end':False}
            self.client.draw({'application_name':'ai-status','priority':50,'elements':[transparent]})
            self.phase='finished'
        if self.phase=='finished':
            self.phase=None;return True
        return False
