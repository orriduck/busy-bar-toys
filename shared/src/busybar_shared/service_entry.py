"""One elapsed-time icon-only coin projection for every local cloud service.

The pure curve takes seconds, independent of preview cadence. Native assets are
samples of this curve; the control plane uses entryDurationMs, never a count of
delivered frames, to fence the entrance. Firmware playback and WAN scheduling
remain separate from the host monotonic clock.
"""
import math
from PIL import Image, ImageEnhance, ImageOps
from .native import encode_sections

# 50 FPS has an exact 20ms native timer period (firmware uses integer 1000/fps).
# Two revolutions finish in 540ms. The first sampled step is <90 degrees, so
# fast front/reverse/edge changes remain resolved rather than strobing at 25FPS.
ENTRY_SECONDS = .54
ENTRY_FPS = 50
ENTRY_ID = 'shared-service-entry'


def coin_motion(elapsed, *, duration=ENTRY_SECONDS):
    """Remaining angle and positive angular speed, in radians and radians/s.

    Two turns, peak speed immediately on entry, continuously decreasing to zero.
    The time curve is independent of native/preview sampling cadence.
    """
    if not math.isfinite(elapsed) or not math.isfinite(duration) or duration <= 0:
        raise ValueError('A service entrance needs finite seconds and positive duration')
    progress = max(0.0, min(1.0, elapsed / duration))
    angle = 4 * math.pi * (1-progress)**3
    speed = 12 * math.pi / duration * (1-progress)**2
    return angle,speed


def coin_pose(elapsed, *, duration=ENTRY_SECONDS):
    angle,_ = coin_motion(elapsed,duration=duration)
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


def wrap_scene(producer, scene, icon, *, position=(0,1)):
    """Turn only the icon rectangle; preserve independent text/scene animation.

    Complete recovery scenes retain the entrance. Numeric updates and renewal
    use the original transparent completion, never another entrance command.
    """
    x,y=position
    if not (0 < icon.width <= 16 and 0 < icon.height <= 14
            and 0 <= x <= 72-icon.width and 0 <= y <= 16-icon.height):
        raise ValueError('The service coin must fit only its front icon rectangle')
    from copy import deepcopy
    result = deepcopy(scene)
    milliseconds = round(ENTRY_SECONDS*1000)
    layer = {'id':ENTRY_ID,'type':'animation','display':'front','x':x,'y':y,
             'z_index':90,'loop':False,'await_previous_end':False}
    entry = producer.asset('service-entry.anim',coin_asset(icon))
    clear = producer.asset('service-entry-clear.anim',transparent_asset(icon.size))
    result['commands'][0]['elements'].append({**layer,'assetHash':entry,'section':'enter'})
    # A later transparent replacement is the renewal target, so long-lived
    # services cannot replay their entrance when the native TTL is renewed.
    result['commands'].append({'offsetMs':milliseconds,'elements':[{**layer,'assetHash':clear,'section':'clear'}]})
    result['commands'].sort(key=lambda command:command['offsetMs'])
    result['entryDurationMs'] = max(result['entryDurationMs'],milliseconds)
    return result
