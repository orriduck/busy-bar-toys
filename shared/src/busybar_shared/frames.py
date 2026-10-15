"""Decode the actual firmware frame formats, independently of advertised MIME type."""
import base64
import binascii
import json
from PIL import Image


def decode_frame(encoded, display):
    if display not in (0, 1): raise ValueError("Unknown display index.")
    try:
        encoded = encoded.strip()
        if encoded.startswith(b'"'):
            encoded = json.loads(encoded).encode("ascii")
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, UnicodeError, binascii.Error):
        raise ValueError("Invalid device framebuffer encoding.") from None
    size = (72, 16) if display == 0 else (160, 80)
    pixels = size[0] * size[1]
    if len(data) == pixels * 3:
        return Image.frombytes("RGB", size, data, "raw", "BGR")
    if display == 1 and len(data) == pixels // 2:
        gray = bytes(value for byte in data for value in ((byte & 15)*17, (byte >> 4)*17))
        return Image.frombytes("L", size, gray).convert("RGB")
    if display == 1 and len(data) == pixels:
        return Image.frombytes("L", size, data).convert("RGB")
    raise ValueError("Unexpected device framebuffer dimensions.")
