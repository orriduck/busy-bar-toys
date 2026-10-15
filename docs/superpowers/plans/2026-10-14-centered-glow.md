# Centered Calendar Layout Implementation Plan

**Goal:** Follow the user's centered calendar layout and left vertical glowing status light.

**Architecture:** Keep network sampling/observer/API ownership unchanged. Share a small RGB glow frame generator between previews and the firmware-native animation encoder, then center the icon/text renderer beside its four-column reserved space.

1. Update animation acceptance tests for 4×16 raw BGR frames, smooth vertical peak travel, and spatial glow falloff. Run failing tests; implement the new generator/encoder under a new asset name.
2. Update renderer tests for the new centered icon/text region, distinct colored arrows and state changes confined to left columns. Run failing tests; implement layout and static glow states. Keep the clock and rate source unchanged.
3. Inspect a scaled preview, run all tests, restart the installed observer and sample actual vertical peaks. Verify waiting stops the light and working restores motion; inspect both actual screens and record evidence.
4. Commit, fast-forward main, push and check CI. Run the user's memory synchronization without storing credentials.
