import struct
import unittest

from busybar_status.animation import thinking_animation


class AnimationTests(unittest.TestCase):
    def test_device_animation_has_valid_full_frames_and_bounces(self):
        data=thinking_animation()
        header=struct.unpack_from('<8sBBBBBHBIIIII',data)
        signature,flags,width,height,color,fps,maxpixels,_,sectionlen,frameslen,sections,frames,displayframes=header
        self.assertEqual((signature,width,height,color,fps,sections,frames),
                         (b'bicycle0',52,1,0,30,1,92))
        self.assertEqual(displayframes,92)
        self.assertEqual(len(data),36+sectionlen+frameslen)
        start,end,offset,duration=struct.unpack_from('<IIIB',data,36)
        self.assertEqual((start,end,offset,duration),(0,91,36+sectionlen,1))
        positions=[]
        for _ in range(frames):
            encoding,duration,size=struct.unpack_from('<BBH',data,offset)
            self.assertEqual((encoding,duration,size),(0,1,156))
            pixels=data[offset+4:offset+4+size]
            positions.append(next(i for i in range(52) if pixels[i*3:i*3+3]==bytes([255,154,69])))
            offset+=4+size
        self.assertEqual(positions,list(range(47))+list(range(45,0,-1)))
        self.assertEqual(offset,len(data))


if __name__=='__main__':unittest.main()
