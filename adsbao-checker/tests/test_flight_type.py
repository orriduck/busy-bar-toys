import unittest
from PIL import Image,ImageDraw
from busybar_shared.graphics import draw_clock
from adsbao_checker.commands import mock_aircraft
from adsbao_checker import display


class FlightTypeTests(unittest.TestCase):
    def test_flight_identity_uses_the_native_bold_seven_pixel_glyphs(self):
        title=getattr(display,'title_image',None)
        self.assertTrue(callable(title),'Flight identity must use the native bold font')
        expected=Image.new('RGB',(80,7));draw_clock(ImageDraw.Draw(expected),(0,0),'JBU462')
        expected=expected.crop(expected.getbbox())
        self.assertEqual(title('JBU462').tobytes(),expected.tobytes())
        self.assertEqual(title('JBU462').height,7)

    def test_wide_eight_character_identity_fits_with_the_aircraft(self):
        title=getattr(display,'title_image',None)
        self.assertTrue(callable(title))
        image=title('WWWW8888')
        self.assertLessEqual(image.width,55)
        self.assertEqual(image.getbbox(),(0,0,image.width,7))
        self.assertEqual(display.render(mock_aircraft())[0].size,(72,16))
