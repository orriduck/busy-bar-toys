import struct
import unittest
from PIL import Image
from busybar_shared.native import encode_sections, prefix_native_section


def records(data):
    h=struct.unpack_from('<8sBBBBBHBIIIII',data)
    result=[];p=36+h[8]
    for _ in range(h[11]):
        _,_,size=struct.unpack_from('<BBH',data,p)
        result.append(data[p:p+4+size]);p+=4+size
    assert p==len(data)
    return h,result


class NativePrefixTests(unittest.TestCase):
    def test_rgb_and_rgba_original_records_and_alpha_are_byte_identical(self):
        for rgba in (False,True):
            for fps,lead in ((30,6),(50,10)):
                mode='RGBA' if rgba else 'RGB'
                frames=[Image.new(mode,(4,3),(23,101,219,alpha) if rgba else (23,101,219)) for alpha in (0,19,255)]
                original=encode_sections((4,3),{'enter':frames},rgba=rgba,fps=fps)
                output=prefix_native_section(original,'enter')
                old,old_records=records(original);h,prefixed=records(output)
                self.assertEqual(h[2:6],old[2:6])
                self.assertEqual(prefixed[lead:],old_records)
                self.assertEqual(h[11],len(old_records)+lead)
                self.assertEqual(h[12],old[12]+lead)
                black=(b'\0\0\0\xff' if rgba else b'\0\0\0')*12
                self.assertTrue(all(r[4:]==black for r in prefixed[:lead]))

    def test_selected_rle_section_records_are_preserved_without_decode(self):
        # Public native RLE: repeat two RGB/BGRA pixels, including a duration2
        # record and nontrivial alpha. The transform must not touch those bytes.
        for mode,stride in ((0,3),(2,4)):
            pixels=bytes([1,2,3,19])[:stride]*2
            raw=struct.pack('<BBH',0,1,len(pixels))+pixels
            encoded=bytes([2])+bytes([11,29,71,17])[:stride]
            rle=struct.pack('<BBH',1,2,len(encoded))+encoded
            selected=[rle,raw]
            names=[('default',0,2,0),('enter',1,2,len(raw))]
            chunk=sum(14+len(name) for name,*_ in names)
            sections=b''.join(struct.pack('<IIIB',a,b,36+chunk+offset,1)+name.encode()+b'\0'
                              for name,a,b,offset in names)
            body=raw+b''.join(selected)
            original=struct.pack('<8sBBBBBHBIIIII',b'bicycle0',0,2,1,mode,30,len(pixels),0,chunk,len(body),2,3,4)+sections+body
            h,result=records(prefix_native_section(original,'enter'))
            self.assertEqual(result[6:],selected)
            self.assertEqual(h[12],6+3)
            self.assertEqual(h[5],30)

    def test_bad_or_oversized_assets_fail_before_publication(self):
        original=encode_sections((72,16),{'enter':[Image.new('RGB',(72,16))]*73})
        with self.assertRaises(ValueError):prefix_native_section(original,'enter')
        for bad in (b'',original[:-1],b'wronghdr'+original[8:]):
            with self.assertRaises(ValueError):prefix_native_section(bad,'enter')
        with self.assertRaises(ValueError):prefix_native_section(original,'missing')


if __name__=='__main__':unittest.main()
