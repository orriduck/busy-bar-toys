import unittest
from PIL import Image
from busybar_shared import native


class WeightedMotionTests(unittest.TestCase):
    def test_staggered_roll_reuses_digit_sampler_and_delays_later_characters(self):
        old=[];new=[]
        for x in (0,4,8):
            a=Image.new('RGB',(12,7));a.paste('white',(x,0,x+3,2));old.append(a)
            b=Image.new('RGB',(12,7));b.paste('white',(x,5,x+3,7));new.append(b)
        result=native.staggered_roll_frame(old,new,1,duration=15,delay=2)
        self.assertEqual(result.crop((0,0,4,7)).tobytes(),
                         native.roll_frame(old[0],new[0],1/15).crop((0,0,4,7)).tobytes())
        for i in (1,2):
            self.assertEqual(result.crop((i*4,0,i*4+4,7)).tobytes(),
                             old[i].crop((i*4,0,i*4+4,7)).tobytes())
        settled=native.staggered_roll_frame(old,new,19,duration=15,delay=2)
        for i in range(3):
            self.assertEqual(settled.crop((i*4,0,i*4+4,7)).tobytes(),
                             new[i].crop((i*4,0,i*4+4,7)).tobytes())

    def test_damped_progress_accelerates_then_settles_without_overshoot(self):
        curve=getattr(native,'settle',None)
        self.assertTrue(callable(curve),'A shared damped progress curve is required')
        values=[curve(i/100) for i in range(101)]
        self.assertEqual((values[0],values[-1]),(0,1))
        self.assertEqual(values,sorted(values))
        self.assertGreater(values[3]-values[2],values[1]-values[0])
        self.assertGreater(values[50],.8)
        self.assertLess(values[50],.88,'Keep visible travel for the slower settling half')
        self.assertLess(values[-1]-values[-2],(values[20]-values[19])/10)

    def test_subpixel_roll_preserves_glyphs_and_uses_fractional_coverage(self):
        sample=getattr(native,'roll_frame',None)
        self.assertTrue(callable(sample),'A shared subpixel roll sampler is required')
        old=Image.new('RGB',(7,7));old.paste((255,255,255),(1,1,3,6))
        new=Image.new('RGB',(7,7));new.paste((255,255,255),(4,1,6,6))
        self.assertEqual(sample(old,new,0).tobytes(),old.tobytes())
        self.assertEqual(sample(old,new,1).tobytes(),new.tobytes())
        values=set(sample(old,new,.13).tobytes())
        self.assertTrue(values-{0,255},'Fractional displacement must not round to whole rows')
        self.assertEqual(sample(old,new,.13).size,(7,7))
