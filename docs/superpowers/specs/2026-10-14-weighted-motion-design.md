# Bold flight identity and weighted motion

Use the device's existing Bold7 font for the flight identity, including letters.
Keep the aircraft, title, and compact detail line centered as one group.
Allow the full eight-character identity without clipping or overlap.

Replace integer-only glyph movement with a shared subpixel roll that preserves
the exact old and new glyphs. Use a damped response with a quick main movement
and a gentle settling phase. Apply it to the clock, network digits, and flight
identity entrance. The flight title can use a short stagger across characters.
Keep digit changes within 400 ms and the complete aircraft entrance within 500 ms.

Replace the thinking bar's triangular position wave with a continuous acceleration
and deceleration cycle. Velocity must reach zero at each endpoint. Keep the existing
blue color, travel range, and approximately three-second round trip. A subtle halo
lag can convey momentum; do not add flashing or large brightness changes.

The user selected critically damped settling without visible overshoot.
Avoid repeated bouncing.

Keep device-native playback at 30 fps, shared transition primitives, reduced-motion
support, alert hold durations, and Codex/calendar restoration. Version changed asset
names to avoid cached native playback. Validate curve endpoints, loop continuity,
glyph endpoints and readability, plus a finite device mock and offline preview.
