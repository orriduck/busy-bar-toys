import base64
import unittest

from busybar_status.frames import decode_frame


class FrameTests(unittest.TestCase):
    def test_front_bgr_pixels_preserve_color(self):
        data = bytes([0, 0, 255]) * (72*16)
        self.assertEqual(decode_frame(base64.b64encode(data), 0).getpixel((0,0)), (255,0,0))

    def test_back_packed_grayscale_is_low_nibble_first(self):
        data = bytes([0xF1]) * (160*80//2)
        image = decode_frame(base64.b64encode(data), 1)
        self.assertEqual(image.getpixel((0,0)), (17,17,17))
        self.assertEqual(image.getpixel((1,0)), (255,255,255))

    def test_bad_frame_has_controlled_error(self):
        with self.assertRaises(ValueError): decode_frame(b'not a frame', 1)


if __name__ == "__main__": unittest.main()
