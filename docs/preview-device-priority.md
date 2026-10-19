# Preview gives priority to the physical display

The local framebuffer bridge is capped at two captures per second and has one
HTTP worker and one read in flight. Missed periods are skipped, never repaid as a
burst. All browser viewers share the existing publisher and its latest-frame
queue; opening another viewer does not create another local capture loop.

The bridge pauses while the selected display is applying, unconfirmed or
unhealthy. Late or queued frames from that paused interval are discarded. A
read already in flight remains subject to the existing bounded read deadline;
this is best-effort yielding based on received scheduler state, not a firmware
priority or preemption guarantee. Collection, publishing and display writes do
not acquire the preview's worker or wait for its frames.

The browser releases its viewer lease when the document is hidden, the window
loses focus, the canvas leaves the viewport, on pagehide, or at teardown. Focus
restores the stream through the existing identity/session checks. Other visible
viewers may legitimately keep the shared demand alive. No capability switch,
registration, credentials or server body/security limit changes are required.
The existing targetFps=30 demand envelope remains accepted for compatibility;
it cannot raise this local implementation's hard two-fps ceiling.

Before this change, local diagnostics showed21.67captures/s,19.68sent/s and
rate-limit reconnects during the user's delay report. That is a measured extra
load, not proof that preview alone caused every delay. Existing serial asset
uploads, queue dwell, capacity retries and WAN latency can still delay a scene.
Historical30fps acceptance targets do not apply to this policy.

Acceptance distinguishes native framebuffer pixels, request acknowledgements,
and browser preview. Low-frequency passive scheduler observations do not prove
first-pixel latency, exact200ms black, or absence of transient flicker.
