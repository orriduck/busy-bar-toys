#!/usr/bin/env python3
"""Offline composition of the actual six cloud scenes. No credentials or I/O.

Native text uses a local font approximation; encoded animation frames and their
coordinates/timing are exact. Every frame asserts that the coin changes no pixel
outside its icon rectangle. This is not physical device acceptance evidence.
"""
import argparse
import base64
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from PIL import Image, ImageDraw
from busybar_apps import load_agents
from busybar_agents.events import Task
from busybar_agents.tokens import TokenUsage
from busybar_apps.gaming import GAMES
from busybar_apps.adsbao.display import notification
from busybar_apps.adsbao.proximity import NearbyAircraft, MILE
from busybar_service.cloud_adapter import AgentRenderer, AgentSignals, CloudQueue
from busybar_service.game_watch import GameRenderer
from busybar_shared.cloud import Producer
from busybar_shared.graphics import draw_clock, tiny_text
from busybar_shared.service_entry import ENTRY_SECONDS, ENTRY_FPS, coin_motion
import math

spec=importlib.util.spec_from_file_location('native_preview',Path(__file__).with_name('motion-preview.py'))
preview=importlib.util.module_from_spec(spec);spec.loader.exec_module(preview)


class NoNetwork:
    def request(self,*args,**kwargs):raise AssertionError('Preview must stay offline')


def scenes(root):
    result=[]
    def producer(alias):
        return Producer(root,{'role':alias,'serviceId':alias,'instanceId':'demo','epoch':'demo'},NoNetwork(),
                        clock=lambda:100,notify=lambda *args:None)
    p=producer('codex'); renderer=AgentRenderer(p)
    renderer.show(Task('demo','turn','codex','DEMO','working',90,100,token_rate=TokenUsage(21,25)),100)
    result.append(('codex',p.state.records['agent']['scene'],dict(p.state.data['assets'])))
    p=producer('agent-notifier'); queue=CloudQueue(p)
    signals=AgentSignals(SimpleNamespace(hide=lambda:None),queue)
    signals.show(Task('demo','waiting','codex','DEMO REQUEST','waiting',90,100),100)
    result.append(('agent-notifier',next(iter(p.state.records.values()))['scene'],dict(p.state.data['assets'])))
    p=producer('adsbao'); queue=CloudQueue(p)
    plane=SimpleNamespace(hex='de0001',identity='DEMO123',kind='B738')
    queue.push([notification(NearbyAircraft(plane,MILE))])
    result.append(('adsbao',next(iter(p.state.records.values()))['scene'],dict(p.state.data['assets'])))
    for game in GAMES:
        p=producer(game.source);GameRenderer(p,game).show('demo',125)
        result.append((game.source,p.state.records['game']['scene'],dict(p.state.data['assets'])))
    return result


class Scene:
    def __init__(self,scene,assets):
        self.scene=scene;self.assets=assets;self.decoded={}
        self.entry=next(e for e in scene['commands'][0]['elements'] if e['id']=='shared-service-entry')
        raw=base64.b64decode(assets[self.entry['assetHash']]['data'])
        _,_,frames=preview.decode_asset(raw)
        self.box=(self.entry['x'],self.entry['y'],self.entry['x']+frames[0].width,self.entry['y']+frames[0].height)
    def frame(self,elapsed,*,coin=True):
        widgets={}
        for c in self.scene['commands']:
            if c['offsetMs']<=round(elapsed*1000):
                for e in c['elements']:
                    if e.get('display')=='front':widgets[e['id']]=(e,c['offsetMs']/1000)
        image=Image.new('RGB',(72,16))
        for e,started in sorted(widgets.values(),key=lambda value:value[0].get('z_index',0)):
            if not coin and e['id']=='shared-service-entry':continue
            if e['type']=='animation':
                key=e['assetHash']
                if key not in self.decoded:self.decoded[key]=preview.decode_asset(base64.b64decode(self.assets[key]['data']))
                fps,sections,frames=self.decoded[key]
                first,last=sections[e.get('section','default')];length=last-first+1
                index=max(0,int((elapsed-started)*fps+1e-6))
                index=index%length if e.get('loop') else min(index,length-1)
                layer=frames[first+index]
            elif e['type']=='xpmbitmap':layer=preview.decode_xpm(e['data'])
            elif e['type']=='image':layer=Image.open(io.BytesIO(base64.b64decode(self.assets[e['assetHash']]['data']))).convert('RGB')
            elif e['type']=='text':
                layer=Image.new('RGBA',(max(1,e.get('width',72-e.get('x',0))),16))
                draw=ImageDraw.Draw(layer)
                if e.get('font')=='bold':draw_clock(draw,(0,0),e['text'])
                else:tiny_text(draw,(0,0),e['text'],e.get('color','#FFFFFFFF'))
            else:continue
            image.paste(layer,(e.get('x',0),e.get('y',0)),layer if layer.mode=='RGBA' else None)
        return image
    def checked_frame(self,elapsed):
        image=self.frame(elapsed);original=self.frame(elapsed,coin=False)
        x,y,r,b=self.box
        for rect in ((0,0,x,16),(r,0,72,16),(x,0,r,y),(x,b,r,16)):
            assert image.crop(rect).tobytes()==original.crop(rect).tobytes(),'Coin escaped its icon rectangle'
        return image


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True);load_agents()
    with tempfile.TemporaryDirectory(prefix='busy-icon-preview-') as root:
        rows=[(alias,Scene(scene,assets)) for alias,scene,assets in scenes(root)]
        samples=(0,.02,.04,.08,.12,.20,.32,ENTRY_SECONDS)
        sheet=Image.new('RGB',(len(samples)*228,6*86+28),'#10151c');draw=ImageDraw.Draw(sheet)
        for n,t in enumerate(samples):draw.text((n*228+8,7),f'{t:.2f}s',fill='white')
        for row,(alias,scene) in enumerate(rows):
            for col,t in enumerate(samples):
                x,y=col*228+6,row*86+29
                draw.text((x,y),alias,fill='white')
                sheet.paste(scene.checked_frame(t).resize((216,48),Image.Resampling.NEAREST),(x,y+18))
        sheet.save(args.output/'icon-only-timeline.png')
        frames=[]
        for n in range(3*ENTRY_FPS+1):
            t=n/ENTRY_FPS
            card=Image.new('RGB',(456,6*116+28),'#10151c');d=ImageDraw.Draw(card)
            d.text((10,7),f'ICON ONLY / synthetic / {t:.2f}s',fill='white')
            for row,(alias,scene) in enumerate(rows):
                y=28+row*116;d.text((10,y),alias,fill='white')
                card.paste(scene.checked_frame(t).resize((432,96),Image.Resampling.NEAREST),(10,y+16))
            frames.append(card)
        frames[0].save(args.output/'icon-only-six-services.gif',save_all=True,append_images=frames[1:],
                       duration=1000//ENTRY_FPS,loop=0,optimize=True,disposal=2)
        metadata={alias:{'iconBounds':scene.box,'entryDurationMs':scene.scene['entryDurationMs'],
                        'coinDurationMs':round(ENTRY_SECONDS*1000)} for alias,scene in rows}
        table=[{'timeMs':round(t*1000),'remainingDegrees':round(math.degrees(coin_motion(t)[0]),3),
                'speedDegreesPerSecond':round(math.degrees(coin_motion(t)[1]),3)}
               for t in (0,.02,.06,.12,.18,.24,.30,.36,.42,.48,ENTRY_SECONDS)]
        (args.output/'coin-motion-table.json').write_text(json.dumps(table,indent=2)+'\n')
        chart=Image.new('RGB',(720,280),'#10151c');cd=ImageDraw.Draw(chart)
        cd.text((20,12),'ICON SPIN / angular speed (degrees per second) / synthetic',fill='white')
        cd.line((60,40,60,236,680,236),fill='#707780',width=1)
        points=[]
        for n in range(101):
            t=ENTRY_SECONDS*n/100;speed=math.degrees(coin_motion(t)[1])
            points.append((60+round(t/ENTRY_SECONDS*620),236-round(speed/4000*180)))
        cd.line(points,fill='#64DCB3',width=3)
        for t in (0,.12,.24,.36,ENTRY_SECONDS):
            x=60+round(t/ENTRY_SECONDS*620);cd.text((x-14,244),f'{t:.2f}s',fill='white')
        for speed in (0,1000,2000,3000,4000):
            y=236-round(speed/4000*180);cd.text((10,y-5),str(speed),fill='white')
        chart.save(args.output/'icon-spin-speed.png')
        (args.output/'manifest.json').write_text(json.dumps({'synthetic':True,'physicalEvidence':False,
            'nativeTextApproximation':True,'outsideIconPixelsUnchanged':True,'coinFps':ENTRY_FPS,
            'maxSampleAngleDegrees':max(math.degrees(coin_motion(n/ENTRY_FPS)[0]-coin_motion((n+1)/ENTRY_FPS)[0])
                for n in range(round(ENTRY_SECONDS*ENTRY_FPS))), 'services':metadata},indent=2)+'\n')
    print(args.output)


if __name__=='__main__':main()
