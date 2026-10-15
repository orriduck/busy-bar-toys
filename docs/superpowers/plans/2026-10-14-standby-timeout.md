# Standby Timeout Implementation Plan

1. Add failing timer tests: ten-second boundary, repeated draws, cancellation/rearm and no timer before a successful standby display.
2. Add a small monotonic standby timer and integrate it with the observer's existing calendar latch and scoped cleanup. Check expiry every poll; new work cancels it.
3. Add an observer regression covering completion→standby→native calendar, no periodic redraw after dismissal, and next-turn resume.
4. Run the suite and verify a clearly labeled finite device demo with real cloud rendering, automatic ten-second clearing and new-turn restoration. Update documentation, install, publish, check CI and run memory sync.
