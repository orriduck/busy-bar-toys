# Local browser verification

2026-10-15. Real local Worker + SQLite Durable Object with isolated mock BUSY upstream (`npm run dev:demo`). No production BUSY API request or physical display acceptance is claimed.

- Sign in with `demo-token`, create service, view one-time publisher credential, close credential modal.
- Publish 5 mock notifications from a local fixture: 2 urgent conditions, 2 grouped PR events, 1 flight. SSE updates the management page without reload; first urgent remains owner, next urgent and lower levels show “待解除”. Group expands into both member records.
- Pause queued flight: it remains visible with no scheduling order; resume control appears. Fixed initial 0 order to em dash. Active owner ETA now says “Now”.
- Save priority57, configRevision increments. A second browser client receives the update over SSE. Its older dirty form remains editable; save returns409 with clear reload warning instead of overwriting priority57.
- Viewed generated concept and actual screenshots: neutral palette/vermilion accent, dot-matrix header, ~2:1 queue/settings, current-owner stripe/hierarchy, table density, form typography/spacing all match the chosen direction. Actual title/detail/time/instance fields intentionally add row height. No fake device name/serial/browser frame or sampled preview is shipped.
- Narrow390px breakpoint: settings stack beneath queue; body/root remain390px, queue scroll region358px with650px table (intentional local horizontal scroll). Explicit CDP device emulation was reset after testing. IAB native viewport override alone did not resize the page, so per-tab CDP override was used.
- Chrome extension repeatedly detached; native Chrome showed blank content despite network loads. Browser verification used Codex in-app browser; no Chrome success claim. Screenshots saved `.local/control-plane-desktop.jpg` and `.local/control-plane-mobile.jpg`; inspected via view_image. Generated reference `.local/control-plane-concept.png` also inspected.

Copy differences from concept are intentional: “All notifications” includes current displayed item and every group member; mock banner always visible; connected/authenticated device is labeled generically because protocol returns verified opaque identity. Every protocol-required setting is present, including exit mode and heartbeat timeout. The credential dialog uses the implemented `busy-bar cloud-setup --url <origin> --role agent|notifier` command; setup discovers the issued epoch from a scoped snapshot and does not activate a service.

Follow-up spec review fixed dormant child ordering while preserving dormant group expansion, explicit selected/applying/offline cards, visible source connectivity and effective exit rule,40px hit targets,900px stacking, and backend-aligned policy ranges. Browser end-current-urgent test handed confirmed ownership from the first urgent item to the second without disturbing the paused flight. The initial testing document's screenshots were refreshed after fixes where noted; physical hardware remains untouched.

Quality review added a login-generation fence and device-bound writes. A stale page cannot mutate the device selected by another page's cookie. A delayed save test (2.5-second network latency) preserved edits made during the request; a second save succeeded. Sign-out removed queue and protected state; reauthentication restored a Live SSE connection. A real browser policy save succeeded with the expected-device header. Session isolation and cross-device writes also have automated regression coverage. The final desktop capture is included at `docs/images/control-plane-management.jpg`.

Final range check saved valid `visibleMs=1001` and `heartbeatMs=5001` through the browser, then restored the demo defaults. Time fields accept fractional display units and round to protocol milliseconds; valid publisher configurations therefore remain editable.

Cloud acceptance: the isolated Workers preview verified HTTPS sign-in and a Live SSE connection. Synthetic notifications survived Worker redeployment. Two pages synchronized priority10→11→10. A synthetic primary action progressed through pending and succeeded, handing display to the next urgent item. Group expansion and flight pause worked. Both management pages were then closed; a later API check found the timed group ended, Codex restored and the paused flight retained, with a healthy backend. The synthetic source continued throughout. The public-demo credential dialog was tested: it shows the synthetic-only instruction and zero collector setup commands. Chrome again failed to attach; cloud UI acceptance used IAB and left Chrome untouched for the parallel task.

Final mode handling uses a three-state value. An unavailable mode endpoint cannot expose a collector command. Verified session responses also supply the server mode. The deployment-wide mode response still updates the signed-out demo hint after an initial session401. Two regression tests cover unknown, hosted demo, production and loopback setup policies; final quality review passed.


## Four-page refresh: local verification, 2026-10-15

This section supersedes the old two-column layout above. Work is on `feat/control-plane-ui`; production rollout and actual end-to-end frame-rate acceptance are still pending.

The isolated local Worker used the simulated BUSY upstream. The synthetic fixture used loopback-only demo credentials and the existing native renderer. It did not read local device credentials or connect to real hardware. Its pixels verify the transport and rendering path only.

Browser checks used IAB after Chrome detached. At 1536 x 1024, Display contains only the centered device and App / Sender / Received queue. At 360 x 800, the body width is 360 with no horizontal overflow. Time uses compact 24-hour hours and minutes, with a full timestamp on hover and in member details. Local screenshots remain under ignored `.local/ui`; `docs/images/control-plane-display.png` contains synthetic data only.

Verified registration on mobile, one-time credential modal, Tab wrap, and return focus to Services when the original submit button has unmounted. Verified configuration draft survives navigation, save succeeds, and a two-page conflict preserves the old draft: priority57 -> first page58; second page59 returned CONFIG_CONFLICT, retained59, and Reload showed58. Verified queue disclosure with actual member sender/instance/receipt time, then pause and resume of the mock aircraft.

The accepted concept and actual desktop/mobile images were inspected. Fidelity ledger:

| Point | Result |
| --- | --- |
| Palette | Native flat black / charcoal workspace, muted neutral labels and red brand retained; illustrative gradients omitted. |
| Navigation | Four entries in approved order; selected rounded pill and compact mobile strip. Outline symbols keep a consistent control style. |
| Workspace | Large rounded panel and quiet border; device and queue share a center axis. |
| Display | Separate blank device illustration surrounds code-rendered 72 by16 pixels. Native time/aggregate-speed content replaces the concept's illustrative rates. |
| Queue | Approximately684px wide, compact59px rows, only three columns while collapsed. Full content/actions are disclosed. |
| Marks | Original ChatGPT/Claude/Dots assets; ADSBao uses an aircraft, correcting the generated concept's unrelated Ads mark. |
| Typography | Sans-serif UI, restrained14–16px labels, compact24-hour receipt time. |
| Responsive |360px viewport tested; sender icon hidden and labels shortened as needed, without changing underlying provenance. |

Independent UI specification and quality reviews passed after fixes for stalled-frame freshness, stream rollover clearing, pacing catch-up, member provenance and modal focus. Ten preview helper tests cover replay/device/stream/size/freshness, pacing and metadata; existing session tests remain. Component lifecycle and actual device throughput still need final integration acceptance. The browser reports measured receive/draw rates and does not repeat frames to claim30fps.


Pacing follow-up: the original strict delay drifted to201 draws over a synthetic10s,60Hz clock with fractional timestamp jitter. Phase-preserving deadlines, a1ms tolerance and a minimum inter-draw guard now produce300. Both0/49/67ms and0/50/67ms stall cases reject the third draw. Independent quality re-review passed10/10 preview tests. A local browser sample over28.679s measured835 fresh received frames (29.12fps) and798 draws (27.82fps); this is synthetic transport evidence, not real-device throughput. Two-page logout eventually cleared the other page on stream revalidation; reauthentication restored the queue and preview.


Final pre-release checks at `deb60a8`:314 Python tests passed locally. Independent Mac spec and quality reviewers passed29 preview tests. An actual local WSS reproduction confirmed retry intervals1.055 /2.072 /4.069 seconds. Both [PR CI](https://github.com/orriduck/busy-bar-toys/actions/runs/38821327434) and [push CI](https://github.com/orriduck/busy-bar-toys/actions/runs/38821322373) passed, including Python3.10/3.14,106 Worker/UI tests, typecheck and production packaging.

Cross-language acceptance used the actual Python PreviewBridge, a real local Worker/DO, actual registered-service snapshots and a synthetic framebuffer factory. This caught and fixed the original top-level enabled fixture mismatch: eligibility now reads config.enabled. Browser diagnostics showed28.8 received /28.8 drawn fps in a sample. After leaving Display, captureRequested and captured stayed687, sent stayed685, demand became false, and the idle cloud connection remained alive. No local Bar or Keychain access occurred in this test.

The user's newly created device key failed to sign in according to their report; its exact URL/error is pending. A separate check with the existing local Keychain key returned200 from both BUSY status endpoints and200/demo:false from the production login endpoint. This does not verify the new key. The diagnostic client initially used Python's default User-Agent and received Cloudflare1010; the existing product User-Agent succeeded. No change was made to authentication to bypass this response.
