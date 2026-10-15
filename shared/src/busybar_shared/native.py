"""Native bicycle0 encoding and reusable fade masks."""
from functools import lru_cache
import struct
from PIL import Image

FPS=30

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
