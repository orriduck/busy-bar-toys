import math
import struct
import unittest
from PIL import Image, ImageDraw
from busybar_shared.service_entry import ENTRY_SECONDS, ENTRY_FPS, coin_motion, coin_pose, coin_frame, coin_asset, wrap_scene


class ServiceEntryTests(unittest.TestCase):
    def setUp(self):
        self.face=Image.new('RGB',(16,14))
        draw=ImageDraw.Draw(self.face)
        draw.rectangle((2,1,6,12),fill='white')
        draw.rectangle((10,4,14,9),fill=(100,220,179))

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
        frame_bytes=16*14*4
        self.assertEqual(asset[-frame_bytes:],bytes(frame_bytes))
        self.assertAlmostEqual((fields[-1]-1)/ENTRY_FPS,ENTRY_SECONDS)

    def test_half_second_spin_is_fast_then_continuously_slows_without_sample_aliasing(self):
        self.assertGreaterEqual(ENTRY_SECONDS,.50)
        self.assertLessEqual(ENTRY_SECONDS,.56)
        self.assertEqual(1000%ENTRY_FPS,0,'Use an exact native millisecond timer period')
        times=[index/ENTRY_FPS for index in range(round(ENTRY_SECONDS*ENTRY_FPS)+1)]
        motion=[coin_motion(t) for t in times]
        self.assertAlmostEqual(motion[0][0],4*math.pi)
        self.assertAlmostEqual(math.degrees(motion[0][1]),4000)
        self.assertEqual(motion[-1],(0,0))
        self.assertTrue(all(a[0]>b[0] and a[1]>b[1] for a,b in zip(motion,motion[1:])))
        steps=[a[0]-b[0] for a,b in zip(motion,motion[1:])]
        self.assertLess(max(steps),math.pi/2,'Resolve each edge/front/reverse change')
        self.assertGreater(max(steps),math.pi/3,'The first sampled turn should be visibly fast')
        self.assertGreater(coin_motion(.12)[1],4*coin_motion(.36)[1])
        self.assertLess(coin_motion(.48)[1],coin_motion(0)[1]/50)

    def test_scene_wrap_is_local_and_never_mutates_other_scene_elements(self):
        from copy import deepcopy
        from types import SimpleNamespace
        assets={}
        def asset(name,data):
            assets[name]=data
            return name
        producer=SimpleNamespace(asset=asset)
        scene={'entryDurationMs':1700,'commands':[{'offsetMs':0,'elements':[
            {'id':'title','type':'text','display':'front','x':17,'text':'WORDS'},
            {'id':'back','type':'xpmbitmap','display':'back','data':'unchanged'}]}]}
        original=deepcopy(scene)
        wrapped=wrap_scene(producer,scene,self.face,position=(0,1))
        self.assertEqual(scene,original)
        self.assertEqual(wrapped['commands'][0]['elements'][:2],original['commands'][0]['elements'])
        entry=wrapped['commands'][0]['elements'][-1]
        self.assertEqual((entry['x'],entry['y']),(0,1))
        header=struct.unpack_from('<8sBBBBBHBIIIII',assets['service-entry.anim'])
        self.assertEqual((header[2],header[3]),(16,14))
        self.assertEqual(wrapped['entryDurationMs'],1700)
        self.assertEqual(wrapped['commands'][-1]['offsetMs'],round(ENTRY_SECONDS*1000))
        with self.assertRaises(ValueError):wrap_scene(producer,scene,Image.new('RGB',(72,16)))


if __name__=='__main__':unittest.main()
