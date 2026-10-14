"""Small native BUSY .anim file: raw full BGR frames, no runtime dependencies.

Format reference (read 2026-10-14): official busybar-firmware tag 1.2.4,
scripts/seq2anim.py Header/Section/FileFrame. Only raw full BGR frames are
emitted. That firmware requires bicycle0; dev's bicycle1 is incompatible.
"""
import struct

ANIMATION_FILE = "thinking-v2.anim"
WIDTH = 52
MARKER_WIDTH = 6
FPS = 30
TRAVEL = WIDTH - MARKER_WIDTH
FRAME_COUNT = TRAVEL * 2


def thinking_offset(now):
    phase = int(now * FPS + 1e-7) % FRAME_COUNT
    return phase if phase <= TRAVEL else FRAME_COUNT - phase


def thinking_animation():
    frames = []
    for number in range(FRAME_COUNT):
        left = thinking_offset(number / FPS)
        pixels = b"".join(bytes((255,154,69)) if left <= x < left+MARKER_WIDTH
                          else bytes((48,32,16)) for x in range(WIDTH))
        frames.append(struct.pack("<BBH", 0, 1, len(pixels)) + pixels)
    name = b"default\0"
    section_length = 13 + len(name)
    section = struct.pack("<IIIB", 0, FRAME_COUNT-1, 36+section_length, 1) + name
    body = b"".join(frames)
    header = struct.pack("<8sBBBBBHBIIIII", b"bicycle0", 0, WIDTH, 1, 0,
                         FPS, WIDTH*3, 0, section_length, len(body), 1, FRAME_COUNT, FRAME_COUNT)
    return header + section + body
