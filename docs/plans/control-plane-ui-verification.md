# Local browser verification

2026-10-15. Real local Worker + SQLite Durable Object with isolated mock BUSY upstream (`npm run dev:demo`). No production BUSY API request or physical display acceptance is claimed.

- Sign in with `demo-token`, create service, view one-time publisher credential, close credential modal.
- Publish 5 mock notifications from a local fixture: 2 urgent conditions, 2 grouped PR events, 1 flight. SSE updates the management page without reload; first urgent remains owner, next urgent and lower levels show “待解除”. Group expands into both member records.
- Pause queued flight: it remains visible with no scheduling order; resume control appears. Fixed initial 0 order to em dash. Active owner ETA now says “Now”.
- Save priority57, configRevision increments. A second browser client receives the update over SSE. Its older dirty form remains editable; save returns409 with clear reload warning instead of overwriting priority57.
- Viewed generated concept and actual screenshots: neutral palette/vermilion accent, dot-matrix header, ~2:1 queue/settings, current-owner stripe/hierarchy, table density, form typography/spacing all match the chosen direction. Actual title/detail/time/instance fields intentionally add row height. No fake device name/serial/browser frame or sampled preview is shipped.
- Narrow390px breakpoint: settings stack beneath queue; body/root remain390px, queue scroll region358px with650px table (intentional local horizontal scroll). Explicit CDP device emulation was reset after testing. IAB native viewport override alone did not resize the page, so per-tab CDP override was used.
- Chrome extension repeatedly detached; native Chrome showed blank content despite network loads. Browser verification used Codex in-app browser; no Chrome success claim. Screenshots saved `.local/control-plane-desktop.jpg` and `.local/control-plane-mobile.jpg`; inspected via view_image. Generated reference `.local/control-plane-concept.png` also inspected.

Copy differences from concept are intentional: “All notifications” includes current displayed item and every group member; mock banner always visible; connected/authenticated device is labeled generically because protocol returns verified opaque identity. Every protocol-required setting is present, including exit mode and heartbeat timeout. Local setup command instructions will be finalized after adapter implementation.
