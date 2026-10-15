import unittest
from PIL import Image,ImageDraw
from busybar_shared.graphics import draw_clock
from busybar_apps.adsbao.commands import mock_aircraft
from busybar_apps.adsbao import display


class FlightTypeTests(unittest.TestCase):
    def test_brand_holds_half_a_second_before_rolling_to_the_flight(self):
        plane=mock_aircraft();total=display.ENTRANCE_FRAMES
        first=display.ICON_ENTER_FRAMES-1
        last=display.ICON_ENTER_FRAMES+display.BRAND_HOLD_FRAMES-1
        frames=[display.render(plane,progress=i/(total-1))[0] for i in range(total)]
        self.assertEqual(display.BRAND_HOLD_FRAMES/30,.5)
        for frame in frames[first:last+1]:
            self.assertEqual(frame.tobytes(),frames[first].tobytes())
        self.assertNotEqual(frames[last].tobytes(),frames[-1].tobytes())
        self.assertEqual(frames[-1].tobytes(),display.render(plane)[0].tobytes())
        self.assertLess(len(display.entrance_asset(plane)),255*1024)

    def test_character_layers_preserve_short_and_compressed_bold_titles(self):
        from PIL import ImageChops
        for text in ('ADSBAO','JBU462','WWWW8888','AAL7'):
            layers=display.title_layers(text,41)
            result=Image.new('RGB',(41,7))
            for layer in layers:result=ImageChops.lighter(result,layer)
            expected=Image.new('RGB',(41,7));expected.paste(display.title_image(text,41),(0,0))
            self.assertEqual(result.tobytes(),expected.tobytes(),text)

    def test_detail_line_contains_only_aircraft_type(self):
        from dataclasses import replace
        plane=mock_aircraft()
        a=display.render(plane)[0]
        b=display.render(replace(plane,distance=plane.distance*2))[0]
        self.assertEqual(a.tobytes(),b.tobytes(),'Distance must not affect the front display')

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
