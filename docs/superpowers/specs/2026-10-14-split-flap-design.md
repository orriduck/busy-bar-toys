# ADSBao split-flap introduction

The user requested an old mechanical departure-board effect. Show `ADSBAO` for
half a second, then change to the bold flight identity.

Keep the aircraft and detail line in their current centered group. Move the
aircraft into place in nine native frames. Hold the brand for fifteen frames.
Flip the title in twelve frames. At 30 fps, the introduction takes 1.2 seconds.
Close the old upper face first. Open the new lower face second. Shade each moving
face and show a dark horizontal hinge during the turn. Preserve exact Bold7
glyphs before and after the flip. Do not add overshoot.

Start the existing ten-second hold after the introduction. Preserve button
dismissal, current Codex/calendar restoration, and reduced-motion static output.
Use a shared image sampler and one native file. Keep it below 255 KiB. Version
the filename so a paused native player cannot retain the previous introduction.

The prior request for stronger settling also remains in scope: give the blue
light a quiet endpoint hold and a faster middle stroke; extend numeric rolls
to 500 ms with visible slower travel before the final glyph settles.

Verify exact static endpoints, upper/lower ordering, brand hold duration, file
size, presenter timing, and the full regression suite. Inspect a rendered
contact sheet and play a finite explicitly synthetic demonstration on the device.
