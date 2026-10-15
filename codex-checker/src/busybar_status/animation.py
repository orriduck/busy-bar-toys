"""Small native BUSY .anim file: raw full BGR frames, no runtime dependencies.

Format reference (read 2026-10-14): official busybar-firmware tag 1.2.4,
scripts/seq2anim.py Header/Section/FileFrame. Only raw full BGR frames are
emitted. That firmware requires bicycle0; dev's bicycle1 is incompatible.
"""
import math
import struct

ANIMATION_FILE = "thinking-v4.anim"
WIDTH = 4
HEIGHT = 16
FPS = 30
FRAME_COUNT = 92
TRAVEL = 13


def thinking_offset(now):
    phase = (now * FPS) % FRAME_COUNT
    return 1 + TRAVEL * (1-math.cos(2*math.pi*phase/FRAME_COUNT))/2


def glow_frame(now, color=(69,154,255), *, moving=True, intensity=1):
    """RGB pixels: small bright core, wider dim halo, smooth subpixel travel."""
    center = thinking_offset(now) if moving else 7.5
    velocity = math.sin(2*math.pi*now*FPS/FRAME_COUNT) if moving else 0
    halo_center = center-.65*velocity
    halo_width = 3.0+.5*abs(velocity) if moving else 3.5
    bright = tuple(c + .35*(255-c) for c in color)
    pixels = bytearray()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            core = math.exp(-.5*((y-center)**2 + (x/.8)**2))
            halo = .18*math.exp(-.5*(((y-halo_center)/halo_width)**2 + (x/1.8)**2))
            pixels.extend(max(0,min(255,round(intensity*(b*core+c*halo))))
                          for b,c in zip(bright,color))
    return bytes(pixels)


def standby_glow():
    """A quiet full-height white hairline, with soft caps and a faint halo."""
    pixels = bytearray()
    for y in range(HEIGHT):
        edge = min(y, HEIGHT-1-y)
        cap = (.55, .8, .95, 1)[min(edge, 3)]
        for level in (208, 44, 10, 0):
            pixels.extend((round(level*cap),) * 3)
    return bytes(pixels)


def thinking_animation():
    frames = []
    for number in range(FRAME_COUNT):
        rgb = glow_frame(number/FPS)
        pixels = b"".join(rgb[i:i+3][::-1] for i in range(0,len(rgb),3))
        frames.append(struct.pack("<BBH", 0, 1, len(pixels)) + pixels)
    name = b"default\0"
    section_length = 13 + len(name)
    section = struct.pack("<IIIB", 0, FRAME_COUNT-1, 36+section_length, 1) + name
    body = b"".join(frames)
    header = struct.pack("<8sBBBBBHBIIIII", b"bicycle0", 0, WIDTH, HEIGHT, 0,
                         FPS, WIDTH*HEIGHT*3, 0, section_length, len(body), 1, FRAME_COUNT, FRAME_COUNT)
    return header + section + body
