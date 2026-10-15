"""Reusable native masks and digit rolls for firmware 1.2.4."""
from functools import lru_cache
import struct
from types import SimpleNamespace
from PIL import Image, ImageDraw

from .animation import ANIMATION_FILE, thinking_animation
from .display import draw_clock, tiny_text, render

FPS=30
PREFIX='motion-v1'
# Region size, fade-out frames, fade-in frames.
REGIONS={'view':((72,16),6,12), 'bar':((4,16),5,7),
         'icon':((14,14),5,7), 'rate':((30,5),4,6)}


def encode_sections(size, sections, *, rgba=False, fps=FPS):
    width,height=size
    if not (1<=width<=255 and 1<=height<=255 and 1<=fps<=255):
        raise ValueError('Invalid native animation dimensions or frame rate')
    if not sections or 'default' in sections:
        raise ValueError('Use named animation sections; default is added automatically')
    mode='RGBA' if rgba else 'RGB'
    encoded=[];ranges=[];index=0;offset=0
    for name,frames in sections.items():
        if not name or not name.isascii() or '\0' in name or not frames:
            raise ValueError('Invalid native animation section')
        start=index;section_offset=offset
        for image in frames:
            if image.size!=size:raise ValueError('Invalid native animation frame dimensions')
            raw=image.convert(mode).tobytes();stride=4 if rgba else 3
            raw=b''.join(raw[i+2:i+3]+raw[i+1:i+2]+raw[i:i+1]+(raw[i+3:i+4] if rgba else b'')
                         for i in range(0,len(raw),stride))
            if len(raw)>65535:raise ValueError('Native frame is too large')
            record=struct.pack('<BBH',0,1,len(raw))+raw
            encoded.append(record);index+=1;offset+=len(record)
        ranges.append((name,start,index-1,section_offset))
    entries=[('default',0,index-1,0)]+ranges
    chunk_size=sum(13+len(name)+1 for name,*_ in entries)
    section_chunk=b''.join(struct.pack('<IIIB',start,end,36+chunk_size+frame_offset,1)
                           +name.encode()+b'\0' for name,start,end,frame_offset in entries)
    body=b''.join(encoded)
    header=struct.pack('<8sBBBBBHBIIIII',b'bicycle0',0,width,height,2 if rgba else 0,
                       fps,max(len(frame)-4 for frame in encoded),0,chunk_size,len(body),
                       len(entries),index,index)
    return header+section_chunk+body


def smooth(t):
    return t*t*(3-2*t)


@lru_cache(maxsize=16)
def fade_asset(size, *, reveal, frames):
    if frames<2:raise ValueError('A fade needs at least two frames')
    images=[]
    for n in range(frames):
        progress=smooth(n/(frames-1))
        alpha=round(255*((1-progress) if reveal else progress))
        images.append(Image.new('RGBA',size,(0,0,0,alpha)))
    return encode_sections(size,{'fade':images},rgba=True)


def digit_image(kind, char):
    if kind=='clock':
        image=Image.new('RGB',(7,7),'black')
        draw_clock(ImageDraw.Draw(image),(0,0),char)
    elif kind=='rate':
        image=Image.new('RGB',(4,5),'black')
        tiny_text(ImageDraw.Draw(image),(0,0),char,'#505050')
    else:raise ValueError('Unknown digit style')
    return image


def digit_frames(kind, old, new, frames=9):
    previous,target=digit_image(kind,old),digit_image(kind,new)
    height=target.height;images=[]
    for n in range(frames):
        shift=round(height*smooth(n/(frames-1)))
        image=Image.new('RGB',target.size,'black')
        image.paste(previous,(0,-shift));image.paste(target,(0,height-shift))
        images.append(image)
    return images


@lru_cache(maxsize=2)
def digit_atlas(kind):
    sections={old+'-'+new:digit_frames(kind,old,new)
              for old in '0123456789' for new in '0123456789' if old!=new}
    return encode_sections(digit_image(kind,'0').size,sections)


def fade_name(region, reveal):
    return f'{PREFIX}-{region}-{"in" if reveal else "out"}.anim'


def bar_name(state):
    return ANIMATION_FILE if state=='working' else f'{PREFIX}-{state}.anim'


@lru_cache(maxsize=1)
def build_assets():
    assets={ANIMATION_FILE:thinking_animation(),
            f'{PREFIX}-clock.anim':digit_atlas('clock'),
            f'{PREFIX}-rate.anim':digit_atlas('rate')}
    for region,(size,out_count,in_count) in REGIONS.items():
        for reveal,count in [(False,out_count),(True,in_count)]:
            assets[fade_name(region,reveal)]=fade_asset(size,reveal=reveal,frames=count)
    for state in ('waiting','standby','error','unknown'):
        task=SimpleNamespace(source='chatgpt',state='done' if state=='standby' else state)
        strip=render(task,0)[0].crop((0,0,4,16))
        assets[bar_name(state)]=encode_sections((4,16),{'hold':[strip]})
    return assets
