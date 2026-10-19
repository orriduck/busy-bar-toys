import math
import struct
import unittest
from PIL import Image, ImageDraw
from busybar_shared.service_entry import ENTRY_SECONDS, ENTRY_FPS, coin_pose, coin_frame, coin_asset


class ServiceEntryTests(unittest.TestCase):
    def setUp(self):
        self.face=Image.new('RGB',(72,16))
        draw=ImageDraw.Draw(self.face)
        draw.rectangle((4,2,22,13),fill='white')
        draw.rectangle((38,4,67,11),fill=(100,220,179))

    def test_same_elapsed_time_has_same_pose_independent_of_sampling_cadence(self):
        expected=coin_frame(self.face,.317)
        for elapsed in (0,.05,.231,.316,.317):
            coin_frame(self.face,elapsed)
        self.assertEqual(coin_frame(self.face,.317).tobytes(),expected.tobytes())
        self.assertEqual(coin_frame(self.face,2).tobytes(),self.face.tobytes())
        with self.assertRaises(ValueError):coin_pose(float('nan'))

    def test_projection_has_reverse_and_thin_edge_then_settles_on_exact_face(self):
        # A quarter of the last revolution is an edge, never a zero-width bitmap.
        edge=ENTRY_SECONDS*(1-(1/8)**(1/3))
        image=coin_frame(self.face,edge)
        bounds=image.getbbox()
        self.assertIsNotNone(bounds)
        self.assertLessEqual(bounds[2]-bounds[0],1)
        reverse=ENTRY_SECONDS*(1-(1/4)**(1/3))
        self.assertLess(coin_pose(reverse)[0],0)
        self.assertNotEqual(coin_frame(self.face,reverse).tobytes(),self.face.tobytes())
        self.assertEqual(coin_frame(self.face,ENTRY_SECONDS).tobytes(),self.face.tobytes())

    def test_native_asset_is_bounded_and_ends_transparent_at_the_timed_deadline(self):
        asset=coin_asset(self.face)
        fields=struct.unpack('<8sBBBBBHBIIIII',asset[:36])
        self.assertEqual(fields[0],b'bicycle0')
        self.assertEqual(fields[5],ENTRY_FPS)
        self.assertLess(len(asset),262144)
        frame_bytes=72*16*4
        self.assertEqual(asset[-frame_bytes:],bytes(frame_bytes))
        self.assertAlmostEqual((fields[-1]-1)/ENTRY_FPS,ENTRY_SECONDS)


if __name__=='__main__':unittest.main()
