# Reference Clock and Network Implementation Plan

> Execute inline using the existing test and verification workflow.

**Goal:** Match the supplied clock and replace gray text with real Mac upload/download speed.

**Architecture:** Add an independent counter sampler, pass a rate snapshot into rendering, use the official pixel font, preserve the existing animation/API layer. Render an explicit idle view when no task exists.

**Tech Stack:** Python, Pillow, macOS route/netstat, BUSY firmware 1.2.4.

- [ ] Add meaningful sampler tests for duplicate network rows, correct byte directions/time deltas, interface/reset/error handling and compact unit bounds. Run to confirm missing implementation, then implement `src/busybar_status/network.py`.
- [ ] Add display acceptance tests for native clock payload pixels, gray speed changes and idle nonanimation behavior. Run failing tests, add the OFL font and renderer changes; remove state text.
- [ ] Integrate snapshots into observer and demo; keep clock/network visible with no task. Run full tests, preview and inspect the layout.
- [ ] Restart observer, measure actual counters and frames, verify WORK/WAIT transitions only change strip behavior, inspect both actual screens, record evidence.
- [ ] Commit, fast-forward main, push and verify CI. Run the user's memory sync without writing credentials or new memory.
