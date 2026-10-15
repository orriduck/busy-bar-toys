# Control plane UI and actual display preview implementation plan

> **For agentic workers:** Use subagent-driven-development to implement each task, with specification review before quality review. Steps use checkbox syntax for tracking.

**Goal:** Ship the approved native BUSY-style four-page control plane, a compact metadata queue, and an actual-device preview targeting 30 fps.

**Architecture:** Keep existing cloud scheduling and authentication. Add a capability-scoped, read-only Mac framebuffer bridge and an ephemeral per-device frame relay; keep pixels out of durable storage. Split UI composition into four pages while preserving session fencing, revision checks and queue controls.

**Tech Stack:** Existing Python 3.10+, websockets, Pillow, React 19, Vite, TypeScript, Workers and SQLite Durable Objects.

Design: `docs/superpowers/specs/2026-10-15-control-plane-ui-design.md`.

## Protocol contract

- Add optional item `app` (1..64 characters, plain validated string). Existing items/publishers without it remain valid. Add boolean service config `allowPreview`, default false, administrator-controlled, independent of `allowInput`.
- `GET /api/preview/publish`: authenticated publisher WebSocket; requires enabled service, current epoch and allowPreview. Header `X-Busy-Instance` is a validated existing identifier. Only one publisher lease is active per device. No device token is passed to the bridge.
- Server sends `{type:'demand',enabled,targetFps:30,streamId,deviceId}` on connection and whenever viewer demand changes. Demand false means zero LAN framebuffer requests.
- Publisher sends `{type:'heartbeat'}` every five seconds even without demand. Frames and heartbeats renew a fifteen-second liveness lease; expiry disconnects and releases the publisher.
- Publisher sends JSON `{type:'frame',sequence,capturedAt,pixels}`. Pixels are standard base64 of exactly 3456 RGB bytes (72x16); messages are bounded. CapturedAt is UTC milliseconds; sequence increases within this connection. Reject malformed, stale, replayed, excessive-rate or no-demand frames. Clock-skew tolerance is bounded and documented.
- `GET /api/preview/frames/<expected-device-id>`: management-session-only SSE. Verify the path identity against the session. Events are `preview` (status with deviceId) and `frame` ({deviceId,streamId,sequence,capturedAt,receivedAt,pixels,width:72,height:16}). Never expose frames to a scoped publisher.
- `POST /api/preview/viewer`: management session and device-bound body `{viewerId,operation:'renew'|'close'}`. Viewer must belong to this session. Initial per-viewer `preview` event includes viewerId. Demand leases last six seconds and renew every two seconds while visible; cleanup uses fetch keepalive close. This bounds capture even when SSE cancellation is delayed.
- `GET /api/preview/status`: management-only diagnostics, including bridge service/instance, demand, actual accepted frame rate, last frame time and viewer count. No pixel data or local endpoint/password.
- Keep at most one latest frame and a bounded number of preview viewers. Drop old frames under backpressure. Revalidate authority after config changes, credential rotation, revocation and expiry. A disconnect clears the cached frame and notifies viewers.

## Task 1: Backend metadata and ephemeral preview relay

**Files:** modify `control-plane/src/model.ts`, `control-plane/src/index.ts`; create `control-plane/src/preview.ts`, `control-plane/tests/preview.test.ts`; extend model/runtime tests and `control-plane/PROTOCOL.md`.

- [x] Add failing model tests: old publish omits app, explicit app survives snapshot, invalid/oversized app fails; allowPreview is false by default and only accepts a boolean.
- [x] Add failing runtime tests using real Worker/DO: no auth 401; publisher cannot view; ordinary publisher cannot ingest; mismatched device denied; two eligible publishers cannot hold the same lease.
- [x] Add failing frame lifecycle tests: demand begins only with viewer; validates 72x16 payload; monotonically increasing sequence; no-demand frame rejected; stale/oversized/flooded messages rejected; viewer cancel stops demand; rotation/disable closes publisher; logout/expiry closes viewer; slow consumer memory remains bounded.
- [x] Run `npm test -- tests/model.test.ts tests/preview.test.ts` and record expected missing-feature failures.
- [x] Implement the contract in a focused relay class. Public routing authenticates before dispatch, forwards a sanitized internal request to the per-device DO, and never forwards arbitrary URLs or credentials to viewers. Update relay authorization metadata whenever state is saved; avoid loading full item/asset state for each frame.
- [x] Run Worker tests, typecheck and Vite build. Review specification, then quality. Commit only the backend-owned files.

## Task 2: Read-only Mac bridge and source metadata

**Files:** create `shared/src/busybar_shared/preview.py`, `shared/tests/test_preview.py`; modify `service/src/busybar_service/cloud_watch.py`, `service/src/busybar_service/cloud_adapter.py`; extend adapter/watch tests.

- [ ] Write tests before implementation for zero captures without demand, cancellation on disconnect, private endpoint validation, local-device serial digest matching the publisher device, redirect refusal, auth failures stopping, strict frame decode/size checks, bounded concurrency, aggregate pacing, late-result discard and latest-frame backpressure.
- [ ] Verify failures with `.venv/bin/python -m unittest discover -s shared/tests -p test_preview.py`.
- [ ] Implement a supervised bridge outside collector/publisher/action/watchdog loops. Read LAN credentials from existing Keychain helper, use only a fixed read-only device endpoint, and reuse the scoped cloud publisher credential. Demand and allowPreview both gate capture. Validate local device identity via GET status before capture. WebSocket reconnect has bounded backoff and stops after authentication rejection. No credentials or private endpoint enter errors/logs/state.
- [ ] Start/stop one bridge with cloud watch, preserving standalone behavior and current input bridge. Keep captures bounded and pace aggregate target 30Hz; do not accumulate catch-up work. Record safe diagnostics only.
- [ ] Add `app` to agent/notifier content using actual source identifiers; preserve item identity, action keys and render behavior.
- [ ] Run Python tests; perform specification and quality review; commit only Python-owned files.

## Task 3: Native BUSY-style four-page UI

**Files:** modify `control-plane/ui/main.tsx`, `common.tsx`, `services.tsx`, `queue.tsx`, `style.css`; create focused `preview.tsx`, `pages.tsx`, `queue-metadata.ts`; add UI tests; add a device-shell asset without private pixels.

- [x] Write behavior tests for explicit app/legacy fallback, sender naming, received time retention, page navigation and session-fenced preview frame acceptance. Validate with `npm test` before implementation.
- [x] Build the extracted neutral dark tokens, red BUSY brand treatment, quiet sidebar and large rounded workspace from the approved concept. Generate a separate faithful blank device-shell asset; actual screen pixels remain code-rendered.
- [x] Display page contains only actual screen and three-column queue. Queue details/actions are disclosed on interaction; preserve groups and all existing operations. Do not turn synthetic fixture content into production seed data.
- [x] Services page provides register and access controls. Configuration page provides revision-checked policy edits and allowPreview control. Device page contains connection, owner, confirmation, preview diagnostics, refresh and sign out.
- [x] Preview subscribes only on visible Display page, verifies device/session/stream/sequence, draws new frames at a 30Hz target with at most one millisecond of RAF timestamp tolerance, and clears stale or revoked pixels. It does not extrapolate animation.
- [x] Verify 1536x1024 and mobile 360px through the browser, all four pages, keyboard, row actions, registration and credential window, config edits/conflicts, two-tab SSE and session replacement. Inspect screenshots with view_image against the concept, and fix mismatches.
- [x] Run tests, typecheck/build. Specification review first, then quality review. Commit UI-owned files.

## Task 4: Integration, performance and release

**Files:** extend relevant integration tests; update English and Chinese control-plane/cloud-client guides; write evidence in `docs/plans/control-plane-ui-verification.md`.

- [ ] Run `.venv/bin/python scripts/run-tests.py`, `npm test`, `npm run typecheck`, `npm run build`, and `npm run dry-run`. Resolve actual failures before broader retesting.
- [ ] Start isolated local demo. Verify first-screen minimal content and no real-source connection to the public synthetic preview. Complete browser and visual acceptance; keep real device captures in ignored `.local` files.
- [ ] Open and attach a PR. Review final behavior and security boundaries, then use passing CI and review evidence for merge/release.
- [ ] Deploy the reviewed production Worker, update the stable Mac service with the reviewed bridge, and enable allowPreview only for the designated existing Mac agent service. Do not change the second Mac or revoke its old token.
- [ ] Measure real native-animation capture -> cloud -> browser fresh frames, rate/jitter/latency and stalls. Verify independent framebuffer/canvas content. Tune acquisition to approximately 30fps on the healthy real network; do not label repeated draws as new captured frames.
- [ ] Verify leaving all Display viewers stops LAN reads, session expiry hides old pixels, and cloud scheduling remains functional after the browser closes.
- [ ] Update issue #13 with implementation and measured acceptance evidence; sync canonical memory only with verified facts. Keep the goal active if any requirement remains unverified.
