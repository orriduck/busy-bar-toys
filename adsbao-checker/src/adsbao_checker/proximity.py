"""Three statute miles, fresh coordinates, and one alert per encounter."""
from dataclasses import dataclass
import json
import math
from pathlib import Path
import tempfile

from .traffic import fresh

MILE=1609.344
RADIUS=3*MILE
REARM_RADIUS=3.5*MILE


def distance_metres(lat1,lon1,lat2,lon2):
    a,b=map(math.radians,(lat1,lat2));dlon=math.radians(lon2-lon1)
    value=math.sin((b-a)/2)**2+math.cos(a)*math.cos(b)*math.sin(dlon/2)**2
    return 6371008.8*2*math.asin(min(1,math.sqrt(max(0,value))))


@dataclass(frozen=True)
class NearbyAircraft:
    aircraft: object
    distance: float


class EncounterTracker:
    def __init__(self,path=None):
        self.path=Path(path) if path else None;self.seen={};self.last_alert=None;self._fixes={}
        if self.path:
            try:
                raw=self.path.read_bytes()
                if len(raw)>131072:raise ValueError('Oversized encounters')
                data=json.loads(raw)
                for key,value in data.get('seen',{}).items():
                    if (isinstance(key,str) and isinstance(value,dict) and
                        type(value.get('alerted')) in (int,float) and math.isfinite(value['alerted'])):
                        outside=value.get('outside')
                        self.seen[key]={'alerted':value['alerted'],'outside':outside if type(outside) in (int,float) and math.isfinite(outside) else None}
                stamp=data.get('last_alert')
                if type(stamp) in (int,float) and math.isfinite(stamp):self.last_alert=stamp
            except (OSError,ValueError,TypeError,AttributeError):pass

    def _save(self):
        if self.path is None:return
        self.path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.path.parent.chmod(0o700)
        with tempfile.NamedTemporaryFile(mode='w',dir=self.path.parent,delete=False) as handle:
            temporary=Path(handle.name)
            try:
                json.dump({'last_alert':self.last_alert,'seen':self.seen},handle)
                handle.flush();temporary.chmod(0o600);temporary.replace(self.path)
            finally:temporary.unlink(missing_ok=True)

    def candidate(self,frame,fix,*,now):
        if frame is None or fix is None or not fresh(frame.fetched_at,now):return None
        self.seen={key:value for key,value in self.seen.items() if -60<=now-value['alerted']<86400}
        choices=[];changed=False
        for plane in frame.aircraft:
            if not fresh(plane.fix_at,now):continue
            if plane.fix_at<self._fixes.get(plane.hex,float('-inf')):continue
            self._fixes[plane.hex]=plane.fix_at
            distance=distance_metres(fix.latitude,fix.longitude,plane.latitude,plane.longitude)
            record=self.seen.get(plane.hex)
            if record:
                if distance>REARM_RADIUS:
                    if record['outside'] is None:record['outside']=now;changed=True
                    elif now-record['outside']>=60:self.seen.pop(plane.hex);record=None;changed=True
                elif record['outside'] is not None:record['outside']=None;changed=True
            if distance<=RADIUS and record is None:choices.append(NearbyAircraft(plane,distance))
        if changed:self._save()
        self._fixes={key:stamp for key,stamp in self._fixes.items() if now-stamp<=300}
        if len(self._fixes)>5000:
            self._fixes=dict(sorted(self._fixes.items(),key=lambda item:item[1],reverse=True)[:5000])
        if self.last_alert is not None and not -60<=now-self.last_alert<86400:self.last_alert=None
        if self.last_alert is not None and now-self.last_alert<30:return None
        return min(choices,key=lambda item:item.distance) if choices else None

    def mark_alerted(self,nearby,*,now):
        self.seen[nearby.aircraft.hex]={'alerted':now,'outside':None};self.last_alert=now
        if len(self.seen)>512:
            self.seen=dict(sorted(self.seen.items(),key=lambda item:item[1]['alerted'],reverse=True)[:512])
        self._save()
