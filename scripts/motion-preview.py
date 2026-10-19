#!/usr/bin/env python3
"""Render the production native assets and controller at 30 fps. No device calls."""
import argparse
from datetime import datetime,timezone
from pathlib import Path
import struct
from types import SimpleNamespace
from PIL import Image,ImageDraw

from busybar_agents.motion import MotionDirector
from busybar_agents.tokens import TokenUsage
from busybar_apps import load_agents


def decode_asset(data):
    h=struct.unpack_from('<8sBBBBBHBIIIII',data);sections={};p=36
    for _ in range(h[10]):
        start,end,offset,duration=struct.unpack_from('<IIIB',data,p)
        end_name=data.index(b'\0',p+13)
        sections[data[p+13:end_name].decode()]=(start,end)
        p=end_name+1
    frames=[];p=36+h[8]
    for _ in range(h[11]):
        encoding,duration,size=struct.unpack_from('<BBH',data,p)
        if encoding not in (0,1) or duration!=1:raise ValueError('Preview supports raw/RLE single-duration frames')
        raw=data[p+4:p+4+size];mode='RGBA' if h[4]==2 else 'RGB'
        if encoding==1:
            stride=4 if h[4]==2 else 3;decoded=bytearray();i=0
            while i<len(raw):
                opcode=raw[i];i+=1;count=opcode&127
                take=count*stride if opcode&128 else stride
                if not count or i+take>len(raw):raise ValueError('Invalid RLE preview frame')
                decoded.extend(raw[i:i+take] if opcode&128 else raw[i:i+take]*count);i+=take
            if len(decoded)!=h[2]*h[3]*stride:raise ValueError('Invalid RLE preview size')
            raw=bytes(decoded)
        frames.append(Image.frombytes(mode,(h[2],h[3]),raw,'raw','BGRA' if h[4]==2 else 'BGR'))
        p+=4+size
    return h[5],sections,frames


def decode_xpm(data):
    rows=data.splitlines();w,h,count,cpp=map(int,rows[1].split())
    palette={r[0]:tuple(bytes.fromhex(r.split('#')[1])) for r in rows[2:2+count]}
    image=Image.new('RGB',(w,h));image.putdata([palette[c] for r in rows[2+count:] for c in r])
    return image


class PreviewDevice:
    def __init__(self,clock,calendar):
        self.clock=clock;self.calendar=calendar;self.assets={};self.widgets={}
    def upload_asset(self,name,data):self.assets[name]=decode_asset(data)
    def clear(self):self.widgets.clear()
    def draw(self,payload):
        now=self.clock()
        for element in payload['elements']:
            if element['display']!='front':continue
            old=self.widgets.get(element['id']);e=dict(element)
            same=(old and old['until']>now and old.get('path')==e.get('path')
                  and e.get('await_previous_end'))
            e['started']=old['started'] if same else now
            e['until']=now+e.get('timeout',15)
            if e['type']=='xpmbitmap':e['image']=decode_xpm(e['data'])
            self.widgets[e['id']]=e
        return True
    def frame(self):
        now=self.clock();widgets=[e for e in self.widgets.values() if e['until']>now]
        canvas=Image.new('RGB',(72,16),'black') if widgets else self.calendar.copy()
        for e in sorted(widgets,key=lambda e:e.get('z_index',0)):
            if e['type']=='animation':
                fps,sections,frames=self.assets[e['path']]
                first,last=sections[e.get('section','default')];length=last-first+1
                index=max(0,int((now-e['started'])*fps+1e-6))
                index=index%length if e.get('loop') else min(index,length-1)
                image=frames[first+index]
            else:image=e['image']
            canvas.paste(image,(e.get('x',0),e.get('y',0)),image if image.mode=='RGBA' else None)
        return canvas


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',default='.local/motion-preview.gif')
    parser.add_argument('--calendar',help='Optional raw 72x16 device calendar capture')
    args=parser.parse_args()
    load_agents()
    calendar=Image.open(args.calendar).convert('RGB') if args.calendar else Image.new('RGB',(72,16))
    if calendar.size!=(72,16):raise ValueError('Calendar reference must be 72x16')
    tick=[0.0];device=PreviewDevice(lambda:tick[0],calendar)
    motion=MotionDirector(device,clock=lambda:tick[0])
    sequence=[('working','chatgpt',1024,2048),('working','chatgpt',2048,4096),
              ('waiting','chatgpt',4096,6144),('working','dots',12288,24576),
              ('error','dots',1024**2,256*1024),('done','chatgpt',1100000,300000)]
    labels=['ENTRY','DIGIT ROLL','COLOR CHANGE','ICON + FIELD FADE','ERROR','STANDBY','CALENDAR RELEASE']
    wall=datetime(2026,10,15,1,52,tzinfo=timezone.utc).timestamp();previous=-1;images=[]
    for frame in range(15*30):
        tick[0]=frame/30
        elapsed=tick[0]-.5
        phase=-1 if elapsed<0 else min(6,int(elapsed/2))
        if phase!=previous:
            if phase<6:
                state,source,up,down=sequence[phase]
                task=SimpleNamespace(state=state,source=source,session_id='demo')
                motion.show(task,wall+phase*60,1,TokenUsage(up,down))
            else:motion.hide()
            previous=phase
        motion.advance()
        card=Image.new('RGB',(600,165),'#11151D');draw=ImageDraw.Draw(card)
        draw.text((12,8),'RENDERED PREVIEW / 30 FPS / '+(labels[phase] if phase>=0 else 'CALENDAR'),fill='white')
        card.paste(device.frame().resize((576,128),Image.Resampling.NEAREST),(12,30))
        images.append(card)
    output=Path(args.output);output.parent.mkdir(parents=True,exist_ok=True)
    # GIF times use 10ms units: 30+30+40 preserves a 30fps average.
    durations=[30 if i%3!=2 else 40 for i in range(len(images))]
    images[0].save(output,save_all=True,append_images=images[1:],duration=durations,
                   loop=0,optimize=True,disposal=2)
    print(output)


if __name__=='__main__':main()
