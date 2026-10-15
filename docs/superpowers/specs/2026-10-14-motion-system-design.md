# Reusable device transitions

Keep the approved layout and state colors. Run animation frames on BUSY Bar, not through repeated cloud requests. Use the verified firmware 1.2.4 bicycle0 format.

## Primitives

1. Fade-in and fade-out: immutable BGRA black masks reveal or cover a region. Use full-view masks for entry and exit. Use smaller masks for the status strip, source icon, and traffic line.
2. Color dip: fade the existing status strip to black, change its source while covered, then fade it in. The old blue strip can keep moving behind the mask. Avoid a stale snapshot or a full-namespace clear during a state change.
3. Digit roll: immutable atlases contain each decimal digit pair. Animate only changed cells. Keep the main image underneath at the final value. Expire each overlay after one second. Reuse atlas files without per-sample uploads.
4. Field fade: if the traffic unit or width changes, fade that region instead of rolling letters or shifting digit columns.

Use 30 fps. Keep normal transition durations below 500 ms, excluding network latency. Use smooth easing without elastic overshoot. Provide a reduced-motion mode that also stops the existing moving blue light.

## Controller

Keep one latest target and a non-blocking out/commit/in sequence. Coalesce targets during fade-out. A new task cancels a pending calendar exit. The observer continues reading lifecycle events and button input during transitions.

Use an animation widget for every status strip in motion mode. This avoids firmware's incompatible widget-type updates and the resulting calendar flash. Refresh the static front/back at the existing cadence. Sample network counters at five-second intervals independently of state-change drawing.

The timer starts after standby is committed. After ten seconds, fade the custom view out, then release only the ai-status namespace. Native calendar pixels cannot be animated as part of the custom view; the device restores them after release. Reduced-motion mode releases immediately.

## Verification

Decode binary assets in tests. Check section offsets, exact source/target frames, alpha endpoints, palette-independent native colors, and bounds. Check latest-target coalescing, interrupted exit, no replay during refresh, inactive/unknown rates, focus conflicts, and no authentication retry storm. Capture actual device sequences for state color changes, entry/exit, and rolling digits. Label demos. Keep device evidence separate from generated previews.

## Sources checked 2026-10-14

- https://github.com/busy-app/busybar-firmware/blob/1.2.4/lib/anim_file/anim_file_format.h
- https://github.com/busy-app/busybar-firmware/blob/1.2.4/lib/anim_file/components/anim_file_start.c
- https://github.com/busy-app/busybar-firmware/blob/1.2.4/applications/services/gui/modules/anim_player.c
- https://github.com/busy-app/busybar-firmware/blob/1.2.4/applications/services/canvas/canvas_widgets.c
