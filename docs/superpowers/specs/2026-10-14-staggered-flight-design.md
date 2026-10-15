# Staggered flight identity

The user replaced the mechanical flip with the existing numeric roll effect.
After the half-second `ADSBAO` hold, change characters from left to right.
Use the shared 500 ms damped vertical roll. Offset adjacent starts by two frames
at 30 fps. Missing destination characters roll to blank; extra characters roll
from blank. Keep exact native Bold7 endpoints, including compressed wide titles.

Partition each fitted title at native glyph boundaries. Roll each character's
layer separately, then combine the visible pixels. Do not split variable-width
glyphs into equal columns. Keep the aircraft and text centered as one group.
The lower front line contains only the aircraft type. Leave it blank if unknown.
Keep distance in the proximity logic and rear diagnostics.

Reserve eight character slots. Nine entry frames, fifteen brand-hold frames,
and twenty-nine staggered-roll frames produce a 53-frame native introduction.
Start the ten-second hold after that introduction. Preserve static reduced
motion, one-shot playback, Start/Pause dismissal, and Codex/calendar restoration.

Verify ordered starts against the numeric sampler, exact title reconstruction,
long and short identities, no front distance, native file size, presenter timing,
restoration, and an actual-device synthetic capture.
