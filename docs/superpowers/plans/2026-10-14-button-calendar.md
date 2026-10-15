# Start/Pause Calendar Implementation Plan

**Goal:** Restore original calendar on Start/Pause until the next real task, with clear thinking/approval/standby lights.

1. Add failing cleanup regression tests; switch namespace scoping to query parameters, validate the official firmware handler and live calls.
2. Add failing standby/approval display tests. Render full-height white standby, stationary yellow waiting, and retain the existing native blue motion.
3. Test persistent view dismissal, old/new turn handling and observer integration. Implement a small private view controller and active-turn identity accessor.
4. Add a real local state-stream reader using the official protocol/SDK. Test START filtering and bounded connection lifecycle without credentials or simulated device-success claims. Wire it into the observer and expose connection status.
5. With a working input transport, verify an actual or documented simulated device Start, sustained native calendar and a new-turn resume. Capture state screens, run all tests, publish and verify CI, then perform the user's memory sync. Report any physical input acceptance still required.
