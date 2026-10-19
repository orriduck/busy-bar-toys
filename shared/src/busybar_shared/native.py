"""Native bicycle0 encoding and reusable fade masks."""
from functools import lru_cache
import math
import struct
from PIL import Image,ImageChops

FPS=30


def _rle_pixels(raw, stride):
    """Firmware RLE: 1..127 repeated or literal BGR/BGRA pixel blocks."""
    pixels=[raw[i:i+stride] for i in range(0,len(raw),stride)]
    out=bytearray();index=0
    while index<len(pixels):
        count=1
        while count<127 and index+count<len(pixels) and pixels[index+count]==pixels[index]:count+=1
        if count>1:
            out.append(count);out.extend(pixels[index]);index+=count
        else:
            start=index;index+=1
            while index<len(pixels) and index-start<127:
                if index+1<len(pixels) and pixels[index]==pixels[index+1]:break
                index+=1
            out.append(0x80|(index-start));out.extend(raw[start*stride:index*stride])
    return bytes(out)


def compact_native_asset(data):
    """Losslessly shrink raw bicycle0 records; retain sections and playback.

    Already-RLE records remain byte-identical. Incompressible raw records stay
    raw. Section offsets and the compressed-input buffer bound are recalculated;
    pixel format, alpha, FPS, frame durations and section periods never change.
    Malformed/unsupported containers raise ValueError for the caller to retain.
    """
    if not isinstance(data,bytes) or len(data)<36:raise ValueError('Invalid native asset')
    h=list(struct.unpack_from('<8sBBBBBHBIIIII',data));body_start=36+h[8]
    if (h[0]!=b'bicycle0' or h[1]!=0 or h[4] not in (0,2) or not h[2] or not h[3]
            or not h[5] or not h[10] or not h[11] or body_start+h[9]!=len(data)):
        raise ValueError('Unsupported native asset')
    sections=[];position=36
    try:
        for _ in range(h[10]):
            if position+14>body_start:raise ValueError()
            first,last,old_offset,period=struct.unpack_from('<IIIB',data,position)
            end=data.index(b'\0',position+13,body_start)
            name=data[position+13:end]
            if not name or not name.isascii() or not 0<=first<=last<h[11]:raise ValueError()
            sections.append((first,last,old_offset,period,name));position=end+1
        if position!=body_start:raise ValueError()
        records=[];starts=[];new_starts=[];position=body_start;new_position=body_start;changed=False
        stride=4 if h[4]==2 else 3
        for _ in range(h[11]):
            if position+4>len(data):raise ValueError()
            encoding,duration,size=struct.unpack_from('<BBH',data,position)
            if encoding not in (0,1) or not duration or not size or position+4+size>len(data):raise ValueError()
            starts.append(position);new_starts.append(new_position)
            record=data[position:position+4+size]
            if encoding==0:
                raw=record[4:]
                if len(raw)!=h[2]*h[3]*stride:raise ValueError()
                packed=_rle_pixels(raw,stride)
                if len(packed)<len(raw):
                    record=struct.pack('<BBH',1,duration,len(packed))+packed;changed=True
            records.append(record);position+=4+size;new_position+=len(record)
        if position!=len(data) or any(old!=starts[first] for first,_,old,_,_ in sections):raise ValueError()
    except (ValueError,struct.error):
        raise ValueError('Invalid native records or sections') from None
    if not changed:return data
    table=b''.join(struct.pack('<IIIB',first,last,new_starts[first],period)+name+b'\0'
                   for first,last,_,period,name in sections)
    body=b''.join(records);h[6]=max(len(r)-4 for r in records);h[9]=len(body)
    return struct.pack('<8sBBBBBHBIIIII',*h)+table+body

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


def settle(t):
    """Critically damped step: acceleration, quick travel, then a quiet tail."""
    t=max(0,min(1,t))
    if t in (0,1):return t
    response=6.5
    return (1-(1+response*t)*math.exp(-response*t))/(1-(1+response)*math.exp(-response))


def roll_frame(previous,target,t):
    """Clip a damped vertical glyph roll, with fractional pixel coverage."""
    if previous.size!=target.size or previous.mode!=target.mode:
        raise ValueError('Roll glyphs must have matching dimensions and modes')
    p=settle(t)
    if p==0:return previous.copy()
    if p==1:return target.copy()
    width,height=target.size
    strip=Image.new(target.mode,(width,height*2))
    strip.paste(previous,(0,0));strip.paste(target,(0,height))
    return strip.transform(target.size,Image.Transform.AFFINE,(1,0,0,0,1,height*p),
                           resample=Image.Resampling.BICUBIC)


def staggered_roll_frame(previous,target,frame,*,duration=15,delay=2):
    """Roll character layers in order with the same damping as numeric glyphs."""
    if duration<=0 or delay<0 or not (previous or target):
        raise ValueError('A staggered roll needs layers and valid timing')
    sample=(previous or target)[0]
    layers=tuple(previous)+tuple(target)
    if any(layer.size!=sample.size or layer.mode!=sample.mode for layer in layers):
        raise ValueError('Character layers must have matching dimensions and modes')
    blank=Image.new(sample.mode,sample.size)
    result=blank.copy()
    for i in range(max(len(previous),len(target))):
        old=previous[i] if i<len(previous) else blank
        new=target[i] if i<len(target) else blank
        rolled=roll_frame(old,new,(frame-i*delay)/duration)
        result=ImageChops.lighter(result,rolled)
    return result


@lru_cache(maxsize=16)
def fade_asset(size, *, reveal, frames):
    if frames<2:raise ValueError('A fade needs at least two frames')
    images=[]
    for n in range(frames):
        progress=smooth(n/(frames-1))
        alpha=round(255*((1-progress) if reveal else progress))
        images.append(Image.new('RGBA',size,(0,0,0,alpha)))
    return encode_sections(size,{'fade':images},rgba=True)


def prefix_native_section(data, section='default', *, lead_ms=200):
    """Prepend opaque black records to one independently playable section.

    Original raw/RLE records (including pixel alpha and duration) are copied
    byte-for-byte. Only the selected section is retained, with a default alias;
    no decompression/re-encoding or producer metadata is involved. At30FPS,
    six frames use the firmware's integer33ms timer (198ms); a separate50FPS
    compositor mask owns the complete200ms reveal boundary.
    """
    if not isinstance(data,bytes) or len(data)<36 or not isinstance(lead_ms,int) or not 0<lead_ms<=1000:
        raise ValueError('Invalid native prefix input')
    header=list(struct.unpack_from('<8sBBBBBHBIIIII',data))
    magic,version,width,height,mode,fps,_,flags,section_bytes,body_bytes,count,frames,_=header
    if (magic!=b'bicycle0' or version!=0 or mode not in (0,2) or not width or not height or not fps
            or not count or not frames or 36+section_bytes+body_bytes!=len(data)):
        raise ValueError('Invalid native prefix header')
    sections={};offset=36;body_start=36+section_bytes
    try:
        for _ in range(count):
            if offset+14>body_start:raise ValueError()
            first,last,record_offset,period=struct.unpack_from('<IIIB',data,offset)
            end_name=data.index(b'\0',offset+13,body_start)
            name=data[offset+13:end_name].decode('ascii')
            if not name or name in sections or not 0<=first<=last<frames:raise ValueError()
            sections[name]=(first,last,record_offset,period)
            offset=end_name+1
        if offset!=body_start or section not in sections:raise ValueError()
        records=[];starts=[];offset=body_start
        for _ in range(frames):
            if offset+4>len(data):raise ValueError()
            encoding,duration,size=struct.unpack_from('<BBH',data,offset)
            if encoding not in (0,1) or duration<1 or size<1 or offset+4+size>len(data):raise ValueError()
            if encoding==0 and size!=width*height*(4 if mode==2 else 3):raise ValueError()
            starts.append(offset);records.append(data[offset:offset+4+size]);offset+=4+size
        if offset!=len(data):raise ValueError()
        first,last,record_offset,period=sections[section]
        if record_offset!=starts[first]:raise ValueError()
    except (ValueError,UnicodeError,struct.error):
        raise ValueError('Invalid native prefix section or frame records') from None
    original=records[first:last+1]
    lead_frames=max(1,round(lead_ms*fps/1000))
    pixel=b'\0\0\0\xff' if mode==2 else b'\0\0\0'
    black=pixel*(width*height)
    if len(black)>65535:raise ValueError('Native prefix frame is too large')
    black_record=struct.pack('<BBH',0,1,len(black))+black
    records=[black_record]*lead_frames+original
    names=['default'] if section=='default' else ['default',section]
    section_bytes=sum(14+len(name) for name in names)
    body=b''.join(records)
    section_chunk=b''.join(struct.pack('<IIIB',0,len(records)-1,36+section_bytes,period)
                          +name.encode('ascii')+b'\0' for name in names)
    header[6]=max(len(record)-4 for record in records)
    header[8:]=[section_bytes,len(body),len(names),len(records),sum(record[1] for record in records)]
    result=struct.pack('<8sBBBBBHBIIIII',*header)+section_chunk+body
    if len(result)>262144:raise ValueError('Prefixed native asset exceeds256KiB')
    return result
