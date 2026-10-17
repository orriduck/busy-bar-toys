# Numeric overlay lifecycle

The clock and token-rate fields have a complete base bitmap. A changed digit adds a short native animation above that bitmap. This animation is a temporary cover; the base bitmap owns the settled value.

## Failure

The standalone renderer gives each roll a one-second timeout. The cloud adapter removes producer timeouts, and the dispatcher gives non-text widgets a 60-second lease. Firmware pauses a non-looping animation at its last frame. The previous RGB digit atlas therefore keeps an opaque old digit above later base updates. A clock change or shorter token value can show stale or overlapping strokes. The same pixels are present in the device framebuffer, before browser preview rendering.

## Repair

Numeric atlases use BGRA frames. Travel frames are fully opaque, including their black background, so the target bitmap does not bleed through the roll. The last frame is fully transparent. A retained widget then has no visible effect, even when later values change or shrink.

Each section has 14 frames at 30 Hz: 13 damped travel frames and one transparent retirement frame. The complete clock atlas stays below the existing 255 KiB asset limit. Shared flight rolls, status-light animation, dispatcher leases, service priorities and registration remain unchanged.

## Verification

The regression decodes the actual generated binary atlas and composites its held last frame over a later, different digit. The old atlas fails this check. Both repaired atlases preserve the later bitmap. All 90 sections also check opaque travel, transparent retirement, exact endpoint glyphs, section offsets and the asset size limit.
