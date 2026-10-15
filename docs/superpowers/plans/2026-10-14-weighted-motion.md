# Weighted Motion Implementation Plan

**Goal:** Use Bold7 flight identities and damped, smooth glyph and light movement.

**Architecture:** Add shared critically damped progress and subpixel glyph sampling.
Use those primitives in Codex rolls and aircraft title entry. Use a continuous
harmonic loop for the thinking bar. Keep native 30 fps playback and existing
visibility/ownership rules.

1. Add curve and subpixel tests in `shared/tests/test_weighted_motion.py`.
   Check exact endpoints, monotonic response, deceleration, and fractional pixels.
2. Implement the shared primitives in `shared/src/busybar_shared/native.py`.
   Use clipped affine sampling; keep the final native glyph unchanged.
3. Add thinking-bar endpoint-speed tests, then replace the triangular position
   with a cosine cycle in `codex-checker/src/busybar_status/animation.py`.
   Keep range 1..14, period 92 frames, and a subtle velocity-dependent halo lag.
4. Use 12-frame damped Codex glyph rolls and version their assets.
5. Add Bold7 title layout tests. Update aircraft title rendering and its native
   15-frame entrance. Bound the title to 55 pixels so an eight-character identity
   and 16-pixel icon fit the display. Synchronize presenter timing with 500 ms.
6. Run all suites, inspect an offline 30 fps sequence and font contact sheet,
   then capture a finite actual-device mock and restore the real observer.
7. Update motion documentation with measured behavior. Scan for credentials,
   merge into the same repo, deploy, verify CI/service health, and clean up.

The user selected critically damped settling without overshoot on 2026-10-14.
