"""Independent location and traffic source; the host owns screen scheduling."""
import json
from pathlib import Path
import tempfile
import time

from .location import (LocationFix, read_location, location_status,
                       start_location_helper, stop_location_helper)
from .traffic import TrafficMonitor
from .proximity import EncounterTracker


def write_private(path,data):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);path.parent.chmod(0o700)
    with tempfile.NamedTemporaryFile(mode='w',dir=path.parent,delete=False) as handle:
        temporary=Path(handle.name)
        try:
            json.dump(data,handle);handle.flush();temporary.chmod(0o600);temporary.replace(path)
        finally:temporary.unlink(missing_ok=True)


def read_config(runtime):
    try:
        raw=(Path(runtime)/'adsbao.json').read_bytes()
        if len(raw)>4096:return None
        data=json.loads(raw)
        if not isinstance(data,dict) or data.get('enabled') is not True:return None
        if data.get('mode')=='auto':return data
        if data.get('mode')=='fixed':
            from .traffic import coordinate_channel
            coordinate_channel(data.get('latitude'),data.get('longitude'))
            return data
    except (OSError,ValueError,TypeError):pass
    return None


def configured_checker(runtime,repo):
    config=read_config(runtime)
    return AircraftChecker(runtime,repo,config) if config else None


class AircraftChecker:
    def __init__(self,runtime,repo,config,*,monitor=None):
        self.runtime=Path(runtime);self.repo=Path(repo);self.config=config
        self.monitor=monitor or TrafficMonitor();self.helper=None
        self.tracker=EncounterTracker(self.runtime/'aircraft-encounters.json')

    def start(self):
        if self.config['mode']=='auto':
            self.helper=start_location_helper(self.repo,self.runtime)
        self.monitor.start()

    def stop(self):
        self.monitor.stop();stop_location_helper(self.helper)

    def poll(self,now):
        if self.config['mode']=='fixed':
            fix=LocationFix(self.config['latitude'],self.config['longitude'],0,now)
        else:fix=read_location(self.runtime/'location.json',now=now)
        self.monitor.update_location(fix)
        return self.tracker.candidate(self.monitor.latest(now=now),fix,now=now)

    def mark_alerted(self,nearby,now):self.tracker.mark_alerted(nearby,now=now)

    def write_status(self,*,active=False):
        location=({'status':'fixed_override'} if self.config['mode']=='fixed' else
                  location_status(self.runtime/'location.json'))
        write_private(self.runtime/'adsbao-status.json',{'enabled':True,'timestamp':time.time(),
                      'location':location,'traffic':self.monitor.status(),'alert_active':active})


def read_status(runtime,*,now=None):
    if not read_config(runtime):return {'enabled':False}
    try:
        data=json.loads((Path(runtime)/'adsbao-status.json').read_text())
        now=time.time() if now is None else now
        if not isinstance(data,dict) or type(data.get('timestamp')) not in (int,float) or not 0<=now-data['timestamp']<=30:
            raise ValueError('Stale status')
        return {key:data[key] for key in ('enabled','location','traffic','alert_active') if key in data}
    except (OSError,ValueError,TypeError):return {'enabled':True,'error':'observer_not_reporting'}
