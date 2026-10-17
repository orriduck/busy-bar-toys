import struct
import unittest
from PIL import Image
from busybar_agents import motion_assets as assets
from busybar_apps import load_agents

load_agents()


def decode(data):
    h=struct.unpack_from('<8sBBBBBHBIIIII',data)
    sections={};p=36
    for _ in range(h[10]):
        start,end,offset,duration=struct.unpack_from('<IIIB',data,p)
        end_name=data.index(b'\0',p+13)
        name=data[p+13:end_name].decode()
        sections[name]=(start,end,offset,duration)
        p=end_name+1
    frames=[];p=36+h[8]
    for _ in range(h[11]):
        encoding,duration,size=struct.unpack_from('<BBH',data,p)
        if encoding!=0 or duration!=1: raise AssertionError('Expected raw single-duration frames')
        frames.append((p,data[p+4:p+4+size]));p+=4+size
    if p!=len(data):raise AssertionError('Trailing or truncated frame data')
    return h,sections,frames


class MotionAssetTests(unittest.TestCase):
    def test_finished_digit_roll_cannot_cover_a_later_base_frame(self):
        # Cloud scenes keep native widgets longer than the standalone 1s
        # timeout. A stopped roll must not freeze an old digit over new data.
        for kind in ('clock','rate'):
            h,sections,frames=decode(assets.digit_atlas(kind))
            _,end,_,_=sections['3-8']
            mode='RGBA' if h[4]==2 else 'RGB'
            rawmode='BGRA' if mode=='RGBA' else 'BGR'
            held=Image.frombytes(mode,(h[2],h[3]),frames[end][1],'raw',rawmode).convert('RGBA')
            later=assets.digit_image(kind,'1').convert('RGBA')
            self.assertEqual(Image.alpha_composite(later,held).tobytes(),later.tobytes(),
                             f'{kind}: the completed overlay still covers later data')

    def test_masks_keep_alpha_endpoints_and_fit_firmware_limits(self):
        for reveal in (False,True):
            data=assets.fade_asset((72,16),reveal=reveal,frames=8)
            h,sections,frames=decode(data)
            self.assertEqual((h[0],h[2],h[3],h[4],h[5]),(b'bicycle0',72,16,2,30))
            alpha=[raw[3] for _,raw in frames]
            self.assertEqual((alpha[0],alpha[-1]),(255,0) if reveal else (0,255))
            self.assertEqual(alpha,sorted(alpha,reverse=reveal))
            self.assertTrue(all(raw[0:3]==bytes(3) for _,raw in frames))
            self.assertLess(len(data),255*1024)

    def test_digit_atlas_sections_point_to_exact_old_and_new_glyphs(self):
        for kind in ('clock','rate'):
            data=assets.digit_atlas(kind)
            h,sections,frames=decode(data)
            self.assertEqual(h[10],91)
            self.assertEqual(h[4],2,'Numeric overlays need explicit alpha')
            for old,new in [('0','1'),('9','0'),('1','8')]:
                start,end,offset,duration=sections[old+'-'+new]
                self.assertEqual(offset,frames[start][0])
                self.assertEqual(duration,1)
                for index,char in [(start,old),(end-1,new)]:
                    rgb=assets.digit_image(kind,char).tobytes()
                    expected=b''.join(rgb[i:i+3][::-1]+b'\xff' for i in range(0,len(rgb),3))
                    self.assertEqual(frames[index][1],expected)
            for name,(start,end,offset,duration) in sections.items():
                if name!='default':
                    self.assertEqual(set(frames[end][1][3::4]),{0},name)
                    self.assertTrue(all(set(raw[3::4])=={255}
                                        for _,raw in frames[start:end]))
            self.assertLess(len(data),255*1024)

    def test_same_digit_has_no_redundant_animation_section(self):
        _,sections,_=decode(assets.digit_atlas('rate'))
        self.assertNotIn('5-5',sections)
        self.assertIn('default',sections)

    def test_encoder_rejects_invalid_dimensions_and_frame_sizes(self):
        for size in [(0,1),(256,1)]:
            with self.assertRaises(ValueError):assets.encode_sections(size,{'part':[Image.new('RGB',(1,1))]})
        with self.assertRaises(ValueError):
            assets.encode_sections((4,4),{'part':[Image.new('RGB',(3,4))]})
