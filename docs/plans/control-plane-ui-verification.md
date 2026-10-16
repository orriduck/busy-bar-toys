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


Final integrated review found one release blocker: a server1008/PREVIEW_PUBLISHER_IDLE close was treated as permanent, so preview would not recover after Mac sleep. `0c8b47c` retries only that reason and PREVIEW_DISCONNECTED with bounded backoff; other1008 policy/auth closures stay terminal. The real local WSS regression covers both transient reasons and UNAUTHORIZED, plus no factory access without demand. Independent integrated re-review passed. The final local Python suite has315 tests; production throughput and the user's new-key login report remain unverified.

## Production rollout and native integration (2026-10-15)

PR #14 is merged at `0de2e9e`. The four-page UI was deployed to the production URL, with `/api/mode` returning `demo:false`. The actual production page has no Demo banner. The public synthetic preview remains a separate environment and retains its warning.

With explicit user confirmation, a new official BUSY API key restricted to the selected Bar was created and used in the production browser sign-in flow. `/api/session`, `/api/events` and `/api/snapshot` returned200; the page showed Connected and Healthy. This verifies that a newly created device key can sign in to production. The user's earlier specific failure was not reproduced, so its cause is not established. The test key was not written to source, logs or memory. The backend was then restored to the existing Keychain-managed device key; no keys were revoked.

Actual firmware `Content-Length` values contained trailing HTTP whitespace. The original read-only bridge rejected the status body before capturing pixels. PR #15 (`d5ab3f0`, main merge `6520945`) trims SP/HTAB only, retaining size, body-count and absolute-deadline checks. Padded status/frame regressions and invalid-header cases pass. All317 Python tests pass locally; PR CI and subsequent main CI pass for Python3.10/3.14 and the control-plane job. The stable Mac checkout was updated, editable installation refreshed, and the existing launchd service restarted in cloud mode.

Real native framebuffer frames now reach the production relay and browser. Sustained acceptance exposed a separate `PREVIEW_RATE_LIMIT` disconnect despite a measured producer average around23–27fps. Temporary production-only aggregate diagnostics identify ingress-bucket exhaustion. Clock and arrival-burst investigation is ongoing. This stage does not establish stable30fps or final release acceptance; transient native frames and synthetic local test rates must not be presented as that result.

Cloudflare Worker/DO updates were observed to propagate at different times; a diagnostic field appeared in the actual per-device DO roughly3.5 minutes after Worker deployment. The [official lifecycle documentation](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) describes eventual consistency across these updates. A successful deploy command alone is insufficient evidence that a live device's DO has switched versions.

### Cloudflare limits audit before the runtime fix

Checked2026-10-15 against the deployed production bindings, baseline source and official documentation. The deployed bindings are Static Assets, a Durable Object namespace, an origin value and two secrets; no Cloudflare Rate Limiting API binding is configured. The observed established-socket JSON `PREVIEW_RATE_LIMIT` is emitted by the application's receive bucket (baseline `6520945`, `preview.ts:272–278`) and its error handler then disconnects the publisher. It is not evidence of a platform-generated HTTP429 or Worker CPU-limit1102.

The [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) document an approximate1,000-request/s soft limit per object, subject to work per request, and a32MiB incoming WebSocket message limit. These are not a30fps limit. [WAF WebSocket handling](https://developers.cloudflare.com/network/websockets/) applies rules to the upgrade request and does not inspect messages after establishment. Cloudflare's [management API quota](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-429/) is a separate API surface; its1,200 requests per five minutes must not be applied to the device pixel stream.

The [runtime timing documentation](https://developers.cloudflare.com/workers/runtime-apis/performance/) states that deployed Date.now/performance.now advance after I/O, while local development clocks advance continuously. The exact production contribution of clock context versus network coalescing is not established by the accepted-frame sample alone. Regression tests therefore cover both, without claiming either as the sole demonstrated cause. No Cloudflare platform limits or security settings were relaxed.

## Official component foundation and persistent preview — 2026-10-15

User approved an approximately150ms bounded playback buffer, then requested the exact official logo/materials, an existing component stack, and a persistent bottom-left preview on the other three pages without Manage.

The UI now uses Tailwind4 and official shadcn/ui Base Nova source components. TanStack Query stores snapshots under device/session-generation keys, after SessionFence acceptance, and owns non-retrying mutations. No credential persistence was added. TanStack Table9 models App / Sender / Received with stable columns and memoized rows. Existing dirty configuration drafts, in-flight edits and revision conflicts remain intact. The one-time credential dialog uses Base UI focus handling; SignIn stays inline.

Official public BUSY logo and blank device shell replace handmade/illustrated approximations; attribution is in control-plane/public/NOTICE.md. At the formal URL, browser DOM measurements confirmed logo80×26 at(24,35), header96px, sidebar264px at(24,96), main x328 with24px right margin, #181818 surface,24px corners and inset highlights. Inter is hosted with the application. Controls use semantic tokens and shared variants; conflicting legacy global control rules were removed.

Exactly one keyed Preview remains mounted across page navigation. The desktop dock is264px wide at left/bottom24px. Mobile places that same node before forms; desktop windows at most430px high also use normal flow to keep navigation reachable. Hidden-document, logout, pagehide, session/device and teardown handling remain in the existing Preview lifecycle. The six-frame/500ms pending-age playout uses actual capture timestamps and local monotonic time, counts actual draws, and includes buffering in measured latency. A real-renderer regression covers a fresh frame arriving after a main-thread stall: clearing the expired displayed surface must preserve the new frame waiting for its150ms gate.

Independent specification and quality reviews passed for buffer, components, composition and layout. Full Worker/UI suite:143 tests across13 files, plus typecheck/build. Latest UI code head2b70f8f has green Python3.10/3.14 and Node CI (PR run38828917722 and push run38828913650). No Python runtime changes were made in this follow-up.

Formal deployment: https://busy-bar-control-plane.orriduck.workers.dev/ ; Worker version2c884150-a36f-4e6b-81ec-a1b76b9cb352; JS index-CoF5a_Ku.js. Browser acceptance used the actual existing authenticated device session and real framebuffer, without creating/rotating production credentials. Production has no Demo banner. Four-page navigation preserved one canvas, monotonically increasing receive/draw counts and the same stream; CDP recorded no new preview-frame SSE request during those navigation actions. Do not infer a device-global viewer count from this per-tab check.

Formal390×844 mobile view had no horizontal overflow and no Manage button. Local1280×320 view put preview in normal flow and left navigation independently scrollable. Local synthetic registration, one-time dialog initial focus/Tab/Escape/focus return, inline sign-out/sign-in, and dirty draft survival through navigation+refresh were checked in the browser. The temporary local test publisher credential was revoked with HTTP200; no production configuration was changed.

Actual private screenshots: .local/ui/formal-services-dock.png and formal-mobile-dock.png, visually inspected and shown to the user. They are intentionally excluded from the public repository. Existing public documentation images remain synthetic and are not evidence of this formal device acceptance.

Throughput is still a limitation. One20.718-second formal navigation window received402 frames and drew389 (about19.4 received/18.8 drawn fps); an earlier independent window measured about25fps. These are different network/capture windows and do not establish a controlled before/after performance comparison. The buffer does not increase source FPS. Stable actual30fps is not accepted or claimed. Source reconnects and bounded stale-frame handling remain expected behavior.


### Default density follow-up — 2026-10-15

At the user's request, application typography and geometry now use a90% root scale, with fixed layout dimensions expressed in rem so Tailwind/shadcn controls, spacing, logo and preview scale together. One-pixel outlines and conservative responsive cutoffs remain unchanged. Browser zoom stays100%; viewport-height calculations still fill the screen.

Formal Worker0940a5c0-646f-423f-a917-c69b3773c3ab, CSS index-h2po1mKZ.css. At1159×1048, root font14.4px; logo72×23.4 at(21.6,31.5), workspace x295.2/y86.4, no horizontal overflow. Display→Services kept the actual pixel preview in the bottom-left dock; console errors/warnings empty. At390×844, no horizontal overflow and preview remained before forms. Private screenshot evidence is in /tmp/busy-bar-density-desktop.png and /tmp/busy-bar-density-mobile.png, excluded from Git. Typecheck, build, production dry-run and143 Worker/UI tests passed. This CSS-only change does not address the separately tracked producer throughput issue.


## Compact service management — 2026-10-15

User explicitly paused FPS work in favor of fast UI iteration. Existing producer-serialization WIP is preserved separately and is not part of this release. The default90% density, official assets, Tailwind/shadcn/TanStack foundation and one persistent Preview remain.

Services groups explicitly registered source-device names, with unprefixed legacy names under Ungrouped. Compact child rows have enable and one credential/revoke menu; Bar buttons and Live preview switches are named and explained there. Configuration starts as a ranked dnd-kit list with mouse and keyboard grips. Clicking expands advanced policy fields. Hidden forms remain mounted; stale revisions are rejected rather than overwritten. Atomic admin-only service-order POST validates the complete permutation before changing priorities or ticking once.

Queue adds HH:mm:ss receipts, priority badges and a thin confirmed-playback indicator. Finite duration uses remaining time after entry animation. Source-controlled/unknown duration is indeterminate. Expired ownership and legacy snapshots fail closed. Sign out uses the destructive shared variant.

At code71844e1:175 Worker/UI tests, typecheck, build and dry-run passed. Independent specification and quality reviews both passed; focused32 tests passed. Push CI38832733096 and PR CI38832758762 passed all Python3.10/3.14 and control-plane jobs. The JS bundle has a Vite size warning after adding dnd-kit; it is recorded rather than suppressed.

Local synthetic browser acceptance verified mouse and keyboard reordering with Order saved, immediate Bar buttons toggle, common action menu, and an unsaved heartbeat91 value surviving Services→Configuration. Production settings and credentials were not changed.

Formal Worker619cdf3b-fd17-4246-9f5f-b825cd5228b9 serves JS index-nzHzWEAS.js and CSS index-CTGcA5qi.css. Formal browser shows This Mac/MacBook groups, collapsed config rows with detail on click, priority badges and second-resolution receipts, destructive sign-out classes, one live canvas and increasing frame counters across navigation. A source stream reconnect was also observed; this does not establish uninterrupted transport or an FPS improvement. Mobile390×844 has no horizontal overflow; actual pixel preview stays before the form. Private screenshots /tmp/busy-compact-{services,config,display,mobile}-production.png were visually inspected and excluded from Git.

Deployment propagation briefly mixed old HTML and missing new JS. A fresh release query subsequently loaded the new UI. The device Durable Object initially continued serving the older additive-metadata-free snapshot, which the new UI handles without a crash or invented progress. Final playback/DO rollout acceptance is tracked separately from static-asset success. No automatic GitHub deployment job exists yet: this release was explicitly deployed with authenticated Wrangler after green CI.
