"""One elapsed-time coin projection for every local cloud service.

The pure curve takes seconds, independent of preview cadence. Native assets are
samples of this curve; the control plane uses entryDurationMs, never a count of
delivered frames, to fence the entrance. Firmware playback and WAN scheduling
remain separate from the host monotonic clock.
"""
import math
from PIL import Image, ImageEnhance, ImageOps
from .native import encode_sections

ENTRY_SECONDS = .72
ENTRY_FPS = 25
ENTRY_ID = 'shared-service-entry'


def coin_pose(elapsed, *, duration=ENTRY_SECONDS):
    if not math.isfinite(elapsed) or not math.isfinite(duration) or duration <= 0:
        raise ValueError('A service entrance needs finite seconds and positive duration')
    progress = max(0.0, min(1.0, elapsed / duration))
    # Two revolutions, monotonically decreasing angular speed, ending face-on.
    angle = 4 * math.pi * (1-progress)**3
    return math.cos(angle), math.sin(angle)


def coin_frame(target, elapsed, *, duration=ENTRY_SECONDS):
    """Horizontal projection, darker reverse, one-pixel edge, exact final face."""
    image = target.convert('RGB')
    if elapsed >= duration:
        return image.copy()
    cosine, sine = coin_pose(elapsed, duration=duration)
    width = max(1, round(image.width * abs(cosine)))
    face = ImageOps.mirror(image) if cosine < 0 else image
    face = face.resize((width, image.height), Image.Resampling.LANCZOS)
    face = ImageEnhance.Brightness(face).enhance((.48 if cosine < 0 else 1) * (1-.28*abs(sine)))
    canvas = Image.new('RGB', image.size, 'black')
    canvas.paste(face, ((image.width-width)//2, 0))
    return canvas


def coin_asset(target):
    # Sample a time function for device playback, not a host frame-count clock.
    times = [index/ENTRY_FPS for index in range(math.ceil(ENTRY_SECONDS*ENTRY_FPS))]
    frames = [coin_frame(target, elapsed).convert('RGBA') for elapsed in times]
    # Non-looping native widgets retain the last frame: leave no stale overlay.
    frames.append(Image.new('RGBA', target.size, (0,0,0,0)))
    return encode_sections(target.size, {'enter':frames}, rgba=True, fps=ENTRY_FPS)


def transparent_asset(size=(72,16)):
    return encode_sections(size, {'clear':[Image.new('RGBA',size,(0,0,0,0))]}, rgba=True)


def wrap_scene(producer, scene, front):
    """Add entry only to complete recovery scenes, never incremental updates."""
    from copy import deepcopy
    result = deepcopy(scene)
    milliseconds = round(ENTRY_SECONDS*1000)
    layer = {'id':ENTRY_ID,'type':'animation','display':'front','x':0,'y':0,
             'z_index':90,'loop':False,'await_previous_end':False}
    entry = producer.asset('service-entry.anim',coin_asset(front))
    clear = producer.asset('service-entry-clear.anim',transparent_asset(front.size))
    result['commands'][0]['elements'].append({**layer,'assetHash':entry,'section':'enter'})
    # A later transparent replacement is the renewal target, so long-lived
    # services cannot replay their entrance when the native TTL is renewed.
    result['commands'].append({'offsetMs':milliseconds,'elements':[{**layer,'assetHash':clear,'section':'clear'}]})
    result['commands'].sort(key=lambda command:command['offsetMs'])
    result['entryDurationMs'] = max(result['entryDurationMs'],milliseconds)
    return result
