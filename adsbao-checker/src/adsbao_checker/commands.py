"""Setup, safe diagnostics, and explicitly synthetic demonstrations."""
import fcntl
import json
from pathlib import Path
import subprocess
import sys
import time
from PIL import Image,ImageDraw

from busybar_shared.api import BusyAPI
from busybar_shared.credentials import read_token
from .checker import read_status,write_private
from .display import ENTRANCE_FRAMES,render
from .location import read_location,location_status,start_location_helper,stop_location_helper
from .presenter import AircraftPresenter
from .proximity import EncounterTracker
from .traffic import parse_envelope,coordinate_channel


def mock_aircraft(now=None):
    """Published example anchor; never presented as this Mac's real location."""
    now=time.time() if now is None else now
    from .location import LocationFix
    fix=LocationFix(42.36,-71.01,0,now)
    frame=parse_envelope({'channel':'nearby:42.36:-71.01','sequence':1,'stale':False,
                         'emittedAt':now,'fetchedAt':now,'data':{'aircraft':{'ac':[
                             {'hex':'aaa02c','flight':'JBU462','t':'A320','lat':42.36,
                              'lon':-70.987,'alt_baro':11000,'fixAt':now}]}}},now=now)
    return EncounterTracker().candidate(frame,fix,now=now)


def register(sub):
    sub.add_parser('adsbao-status',help='Show safe aircraft/location diagnostics')
    command=sub.add_parser('adsbao-location',help='Enable ADSBao with native location authorization')
    command.add_argument('--fixed',type=float,nargs=2,metavar=('LAT','LON'),help='Explicit private fixed observation point')
    command=sub.add_parser('adsbao-demo',help='Show a finite mock aircraft alert; stop the observer first')
    command.add_argument('--reduced-motion',action='store_true')
    command=sub.add_parser('adsbao-preview',help='Render a synthetic aircraft preview without device or location access')
    command.add_argument('--output',default='.local/adsbao-preview')


def configure_location(args,runtime,repo):
    if args.fixed:
        lat,lon=args.fixed;coordinate_channel(lat,lon)
        write_private(runtime/'adsbao.json',{'enabled':True,'mode':'fixed','latitude':lat,'longitude':lon})
        print('Private fixed observation point saved. Reinstall the service to apply it.')
        return 0
    executable=repo/'.venv/BusyBarLocation.app/Contents/MacOS/BusyBarLocation'
    if not executable.exists():
        subprocess.run([sys.executable,str(repo/'scripts/build-location-helper.py')],check=True)
    write_private(runtime/'adsbao.json',{'enabled':True,'mode':'auto'})
    if read_location(runtime/'location.json'):
        print('Recent system location is ready. Reinstall the service to enable ADSBao.')
        return 0
    print('Allow Busy Bar Location in the macOS location dialog if requested.',flush=True)
    helper=start_location_helper(repo,runtime,request_authorization=True)
    if helper is None:raise RuntimeError('Could not start the native location helper.')
    try:
        deadline=time.monotonic()+45
        while time.monotonic()<deadline:
            status=location_status(runtime/'location.json')
            if status['status']=='ok':
                print(json.dumps(status));print('System location ready. Reinstall the service to enable ADSBao.')
                return 0
            if status['status'] in ('denied','restricted','services_disabled','timeout'):
                print(json.dumps(status));return 1
            time.sleep(.25)
        print(json.dumps(location_status(runtime/'location.json')))
        return 1
    finally:stop_location_helper(helper)


def demo(args,runtime):
    runtime.mkdir(mode=0o700,parents=True,exist_ok=True)
    lock=(runtime/'watch.lock').open('a')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close();raise RuntimeError('Stop the observer before the aircraft demo; reinstall it afterward.') from None
    client=BusyAPI(read_token());presenter=AircraftPresenter(client,reduced=args.reduced_motion)
    try:
        if not presenter.start(mock_aircraft(),demo=True):
            print('Device focus mode suppressed the mock demo.');return 0
        while presenter.active:presenter.advance();time.sleep(.05)
    finally:
        client.clear();lock.close()
    return 0


def preview(output):
    output=Path(output);output.mkdir(parents=True,exist_ok=True)
    plane=mock_aircraft();cards=[]
    for progress in [0,.25,.5,.75,1]:
        front,back=render(plane,progress=progress,demo=True)
        card=Image.new('RGB',(600,165),'#11151D');draw=ImageDraw.Draw(card)
        draw.text((12,8),f'RENDERED MOCK / ENTRANCE {progress:.0%}',fill='white')
        card.paste(front.resize((576,128),Image.Resampling.NEAREST),(12,30));cards.append(card)
    sheet=Image.new('RGB',(600,165*len(cards)),'#11151D')
    for i,card in enumerate(cards):sheet.paste(card,(0,165*i))
    sheet.save(output/'preview.png')
    images=[]
    for i in range(90):
        progress=min(1,i/(ENTRANCE_FRAMES-1))
        front=render(plane,progress=progress,demo=True)[0]
        if i>=84:front=Image.blend(front,Image.new('RGB',front.size),min(1,(i-84)/5))
        card=Image.new('RGB',(600,165),'#11151D');draw=ImageDraw.Draw(card)
        draw.text((12,8),'RENDERED MOCK / 30 FPS / SHORT PREVIEW',fill='white')
        card.paste(front.resize((576,128),Image.Resampling.NEAREST),(12,30));images.append(card)
    images[0].save(output/'preview.gif',save_all=True,append_images=images[1:],
                   duration=[30 if i%3!=2 else 40 for i in range(90)],loop=0,disposal=2)
    print(output/'preview.png')
    return 0


def run(args,runtime,repo):
    if args.command=='adsbao-status':print(json.dumps(read_status(runtime),indent=2));return 0
    if args.command=='adsbao-location':return configure_location(args,runtime,repo)
    if args.command=='adsbao-demo':return demo(args,runtime)
    if args.command=='adsbao-preview':return preview(args.output)
    raise ValueError('Unknown aircraft command')
