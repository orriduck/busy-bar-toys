import struct
import unittest

from busybar_status.animation import thinking_animation,thinking_offset


class AnimationTests(unittest.TestCase):
    def test_light_pauses_at_each_end_before_a_faster_middle_stroke(self):
        values=[thinking_offset(i/30) for i in range(93)]
        self.assertEqual(values[:7],[1]*7)
        self.assertEqual(values[40:53],[14]*13)
        self.assertGreater(values[24]-values[23],.65)

    def test_endpoint_speed_is_slow_and_turnaround_is_continuous(self):
        values=[thinking_offset(i/30) for i in range(93)]
        self.assertLess(values[1]-values[0],(values[23]-values[22])/10)
        self.assertLess(values[46]-values[45],(values[23]-values[22])/10)
        epsilon=.0001;bottom=46/30
        left=(thinking_offset(bottom)-thinking_offset(bottom-epsilon))/epsilon
        right=(thinking_offset(bottom+epsilon)-thinking_offset(bottom))/epsilon
        self.assertLess(abs(left),.02)
        self.assertAlmostEqual(left,-right,places=5)

    def test_device_animation_is_vertical_with_glowing_frames_and_no_jump(self):
        data=thinking_animation()
        header=struct.unpack_from('<8sBBBBBHBIIIII',data)
        signature,flags,width,height,color,fps,maxpixels,_,sectionlen,frameslen,sections,frames,displayframes=header
        self.assertEqual((signature,width,height,color,fps,sections,frames),
                         (b'bicycle0',4,16,0,30,1,92))
        self.assertEqual(displayframes,92)
        self.assertEqual(len(data),36+sectionlen+frameslen)
        start,end,offset,duration=struct.unpack_from('<IIIB',data,36)
        self.assertEqual((start,end,offset,duration),(0,91,36+sectionlen,1))
        positions=[]
        for _ in range(frames):
            encoding,duration,size=struct.unpack_from('<BBH',data,offset)
            self.assertEqual((encoding,duration,size),(0,1,192))
            pixels=data[offset+4:offset+4+size]
            # BGR is brightest in the blue channel; the leading column carries
            # the bright core, with a weaker halo toward the content.
            levels=[pixels[y*width*3] for y in range(height)]
            peak=max(range(height),key=levels.__getitem__)
            positions.append(peak)
            blue,green,red=pixels[peak*width*3:peak*width*3+3]
            self.assertGreater(blue,green)
            self.assertGreater(green,red)
            self.assertGreater(levels[peak],pixels[(peak*width+3)*3])
            self.assertGreater(pixels[(peak*width+3)*3],0)
            offset+=4+size
        self.assertEqual((positions[0],positions[46]),(1,14))
        self.assertEqual((min(positions),max(positions)),(1,14))
        self.assertTrue(all(abs(b-a)<=1 for a,b in zip(positions,positions[1:]+positions[:1])))
        self.assertEqual(positions[:47],sorted(positions[:47]))
        self.assertEqual(positions[46:],sorted(positions[46:],reverse=True))
        self.assertEqual(offset,len(data))


if __name__=='__main__':unittest.main()
