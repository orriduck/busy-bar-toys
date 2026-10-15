# Centered calendar layout and vertical glow

User direction: center the calendar-like icon/clock/network group, make traffic compact, color upload/download arrows differently, and move the status effect to the far-left columns with vertical motion and a luminous trail/halo.

Reserve x=0..3 for a 4×16 native animation. In the remaining area, center a fixed-width group containing the approved icon (14×14, vertically centered), a three-pixel gap, and a 40-pixel text panel. Center the native BUSY clock in the upper row and center compact gray rates in the lower row. Upload arrow is amber, download arrow cyan. Numeric traffic remains gray. No WORK/WAIT words and no bottom horizontal bar.

The working light has a bright pale-blue core and a softer blue halo. Its center moves smoothly from y=1 to y=14 and back over 92 frames at 30fps. Subpixel brightness changes soften the limited physical resolution. A new native animation filename prevents stale cached dimensions. Other states use a stationary state-colored light; idle is dim. Idle clock/network, network sampling, priority 50 and scoped cleanup stay unchanged.

Acceptance: centered group stable across rate changes, distinct arrow colors survive XPM quantization, no bottom strip, device-native 4×16 animation with both vertical directions and gradient falloff, and clock/rates remain legible on actual front/back captures.
