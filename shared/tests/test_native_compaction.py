"""Independent byte-level playback checks for native transport compaction."""
import base64
import hashlib
import random
import struct
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from busybar_shared.cloud import CloudError, Producer
from busybar_shared.native import compact_native_asset, encode_sections


def decoded(data):
    h=struct.unpack_from('<8sBBBBBHBIIIII',data);stride=4 if h[4]==2 else 3
    sections=[];p=36
    for _ in range(h[10]):
        first,last,offset,period=struct.unpack_from('<IIIB',data,p);end=data.index(b'\0',p+13)
        sections.append((data[p+13:end],first,last,offset,period));p=end+1
    frames=[];starts=[];p=36+h[8];sizes=[]
    for _ in range(h[11]):
        starts.append(p);kind,duration,n=struct.unpack_from('<BBH',data,p);raw=data[p+4:p+4+n];sizes.append(n)
        if kind==1:
            result=bytearray();i=0
            while i<len(raw):
                op=raw[i];i+=1;count=op&127
                if not count:raise AssertionError('empty opcode')
                nbytes=count*stride if op&128 else stride
                block=raw[i:i+nbytes]
                if len(block)!=nbytes:raise AssertionError('truncated opcode')
                result.extend(block if op&128 else block*count);i+=nbytes
            raw=bytes(result)
        elif kind!=0:raise AssertionError('unexpected record')
        if len(raw)!=h[2]*h[3]*stride:raise AssertionError('pixel size')
        frames.append((duration,raw));p+=4+n
    assert p==len(data)
    assert all(offset==starts[first] for _,first,_,offset,_ in sections)
    return h,[(name,first,last,period)for name,first,last,_,period in sections],frames,sizes


class NativeCompactionTest(unittest.TestCase):
    def test_rgb_rgba_sections_frame_durations_and_alpha_are_identical(self):
        for rgba in (False,True):
            mode='RGBA' if rgba else 'RGB';stride=4 if rgba else 3
            # Runs straddle the firmware127-pixel opcode boundary; literals
            # include adjacent repeated pairs and varying partial alpha.
            values=([tuple([12,37,91,19][:stride])]*128
                    +[tuple([(i*43)%256,(i*71)%256,(i*13)%256,(i*19)%256][:stride])for i in range(128)])
            mixed=Image.new(mode,(16,16));mixed.putdata(values)
            transparent=Image.new(mode,(16,16),(0,0,0,0)if rgba else (0,0,0))
            source=bytearray(encode_sections((16,16),{'enter':[mixed,transparent],'clear':[transparent]},rgba=rgba,fps=50))
            header=struct.unpack_from('<8sBBBBBHBIIIII',source);source[36+header[8]+1]=3
            struct.pack_into('<I',source,32,header[12]+2)
            source=bytes(source);packed=compact_native_asset(source)
            before=decoded(source);after=decoded(packed)
            self.assertEqual(after[0][:6],before[0][:6]);self.assertEqual(after[0][10:],before[0][10:])
            self.assertEqual(after[1:3],before[1:3])
            self.assertEqual(after[0][6],max(after[3]))
            self.assertLess(len(packed),len(source))
            self.assertEqual(compact_native_asset(packed),packed)

    def test_incompressible_records_stay_byte_identical(self):
        image=Image.frombytes('RGBA',(16,16),random.Random(7).randbytes(16*16*4))
        source=encode_sections((16,16),{'noise':[image]},rgba=True)
        self.assertEqual(compact_native_asset(source),source)

    def test_mixed_raw_and_existing_rle_are_idempotent(self):
        noise=Image.frombytes('RGB',(16,16),random.Random(2).randbytes(16*16*3))
        source=encode_sections((16,16),{'all':[Image.new('RGB',(16,16)),noise]})
        packed=compact_native_asset(source)
        self.assertEqual(decoded(packed)[2],decoded(source)[2])
        h=decoded(packed)[0];p=36+h[8]
        self.assertEqual(packed[p],1);p+=4+struct.unpack_from('<H',packed,p+2)[0]
        self.assertEqual(packed[p],0)
        self.assertEqual(compact_native_asset(packed),packed)
        for bad in (b'',source[:-1],source[:8]+b'\xff'+source[9:]):
            with self.assertRaises(ValueError):compact_native_asset(bad)

    def test_producer_hashes_and_uploads_compacted_bytes_once_without_weakening_limits(self):
        class HTTP:
            def __init__(self):self.calls=[]
            def request(self,method,path,body=None):
                self.calls.append((path,body));return {'hash':body['hash']}if path=='/api/assets'else{}
        with tempfile.TemporaryDirectory()as root:
            http=HTTP();p=Producer(root,{'role':'demo','serviceId':'demo','instanceId':'demo','epoch':'e'},http,clock=lambda:100)
            original=encode_sections((72,16),{'clear':[Image.new('RGBA',(72,16))]},rgba=True)
            digest=p.asset('first.anim',original)
            self.assertEqual(p.asset('second.anim',original),digest)
            packed=base64.b64decode(p.state.data['assets'][digest]['data'])
            self.assertEqual(hashlib.sha256(packed).hexdigest(),digest)
            self.assertEqual(decoded(packed)[1:3],decoded(original)[1:3])
            scene={'entryDurationMs':0,'commands':[{'offsetMs':0,'elements':[{'id':'a','type':'animation','assetHash':digest}]}]}
            p.state.recognize('a',kind='event',level='info',title='public fixture',detail='',scene=scene)
            p.flush();p.flush()
            uploads=[body for path,body in http.calls if path=='/api/assets']
            self.assertEqual(len(uploads),1);self.assertEqual(base64.b64decode(uploads[0]['data']),packed)
            unknown=b'bicycle0unsupported';self.assertEqual(p.asset('variant.anim',unknown),hashlib.sha256(unknown).hexdigest())
            with self.assertRaises(CloudError):p.asset('too-big.anim',b'bicycle0'+bytes(262144))
