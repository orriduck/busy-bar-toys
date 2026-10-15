# Start/Pause dismiss and Codex standby

User-approved behavior: the physical Start/Pause button restores the original firmware calendar. Keep it there until a new task turn starts. While still in Codex mode: a blue vertically moving light means thinking, a stationary yellow glow means approval/input requested, and a full-height white light means standby. Completion and interruption enter standby; unknown/error stay visibly distinct rather than implying completion.

Read actual START PRESS events from the firmware state stream. The current BAR Cloud REST token cannot open a state stream (ticket request returned 401), and firmware 1.2.4 swallows Start in its canvas overlay. Therefore a local USB/Wi-Fi WebSocket connection is required. Do not infer a Start press from screen pixels. USB is auto-discovered at the documented 10.0.4.20 endpoint; Wi-Fi requires an authenticated local connection. No account/browser credentials are extracted.

After START, stop all overlay refreshes and clear only ai-status; the original underlying firmware screen is revealed. Persist the dismissed view and all active turn identities in the private runtime directory. State updates/completion/selection changes among existing turns must not reopen the overlay. A newly active turn clears the dismissal and resumes Codex. Input reception continues while viewing the calendar. Repeated presses in calendar mode do not reopen Codex.

Critical firmware compatibility: clear must use DELETE /display/draw?application_name=ai-status with no JSON namespace body. Firmware 1.2.4 shadows its body parameter, so query scope is necessary to avoid clearing another application's canvas.

Acceptance: real Start input, persistent calendar through multiple refresh intervals and service restarts, old-turn state changes ignored, a new turn restores the overlay, correct blue/yellow/full-white light frames, and input disconnect/reconnect is reported accurately. Never claim physical-button acceptance from a fixture or simulated event.
