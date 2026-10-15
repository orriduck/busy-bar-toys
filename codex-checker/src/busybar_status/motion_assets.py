"""Reusable native masks and digit rolls for firmware 1.2.4."""
from functools import lru_cache
from types import SimpleNamespace
from PIL import Image, ImageDraw

from .animation import ANIMATION_FILE, thinking_animation
from .display import draw_clock, tiny_text, render

from busybar_shared.native import FPS, encode_sections, fade_asset, roll_frame
PREFIX='motion-v2'
# Region size, fade-out frames, fade-in frames.
REGIONS={'view':((72,16),6,12), 'bar':((4,16),5,7),
         'icon':((14,14),5,7), 'rate':((30,5),4,6)}


def digit_image(kind, char):
    if kind=='clock':
        image=Image.new('RGB',(7,7),'black')
        draw_clock(ImageDraw.Draw(image),(0,0),char)
    elif kind=='rate':
        image=Image.new('RGB',(4,5),'black')
        tiny_text(ImageDraw.Draw(image),(0,0),char,'#505050')
    else:raise ValueError('Unknown digit style')
    return image


def digit_frames(kind, old, new, frames=12):
    previous,target=digit_image(kind,old),digit_image(kind,new)
    return [roll_frame(previous,target,n/(frames-1)) for n in range(frames)]


@lru_cache(maxsize=2)
def digit_atlas(kind):
    sections={old+'-'+new:digit_frames(kind,old,new)
              for old in '0123456789' for new in '0123456789' if old!=new}
    return encode_sections(digit_image(kind,'0').size,sections)


def fade_name(region, reveal):
    return f'{PREFIX}-{region}-{"in" if reveal else "out"}.anim'


def bar_name(state):
    return ANIMATION_FILE if state=='working' else f'{PREFIX}-{state}.anim'


@lru_cache(maxsize=1)
def build_assets():
    assets={ANIMATION_FILE:thinking_animation(),
            f'{PREFIX}-clock.anim':digit_atlas('clock'),
            f'{PREFIX}-rate.anim':digit_atlas('rate')}
    for region,(size,out_count,in_count) in REGIONS.items():
        for reveal,count in [(False,out_count),(True,in_count)]:
            assets[fade_name(region,reveal)]=fade_asset(size,reveal=reveal,frames=count)
    for state in ('waiting','standby','error','unknown'):
        task=SimpleNamespace(source='chatgpt',state='done' if state=='standby' else state)
        strip=render(task,0)[0].crop((0,0,4,16))
        assets[bar_name(state)]=encode_sections((4,16),{'hold':[strip]})
    return assets
