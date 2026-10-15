import unittest
from PIL import Image
from busybar_shared import native


class WeightedMotionTests(unittest.TestCase):
    def test_damped_progress_accelerates_then_settles_without_overshoot(self):
        curve=getattr(native,'settle',None)
        self.assertTrue(callable(curve),'A shared damped progress curve is required')
        values=[curve(i/100) for i in range(101)]
        self.assertEqual((values[0],values[-1]),(0,1))
        self.assertEqual(values,sorted(values))
        self.assertGreater(values[3]-values[2],values[1]-values[0])
        self.assertGreater(values[50],.85)
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
