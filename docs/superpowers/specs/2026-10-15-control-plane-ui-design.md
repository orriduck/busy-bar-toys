# BUSY Bar control plane UI refresh

Status: layout and four-page structure approved by the user on 2026-10-15. Sender and Received semantics approved. Preview transport is an implementation design; sustained end-to-end performance remains to be verified.
Issue: https://github.com/orriduck/busy-bar-toys/issues/13
Baseline: main commit 228657e.

## User requirements

1. Match the visual language of BUSY's official site, docs, and the supplied device settings page.
2. Move connection and device metadata out of the first screen.
3. Show the current Bar front display and the message queue on the first screen. Target 30 actual framebuffer captures per second. Each collapsed queue row shows only app, sender, and time.
4. Provide separate pages for service registration, scheduling configuration, and device information.

The original device screenshot is private and is not committed. The generated design is a visual reference, not a screenshot of the live device. Its screen text, queue rows, and product imagery are illustrative.

## Information architecture

Use a fixed left navigation with four entries, in this order:

- Display: live front-display pixels, then the compact queue.
- Services: register a service, read its name and template, rotate or revoke its publisher credential.
- Configuration: enable a service, set priority, exit rule, hold duration, later interval, and heartbeat timeout.
- Device: current controller, API confirmation and health, source/preview connection, actual capture/delivery rate and age, device identity, configuration revision, refresh and sign out.

The pages retain the same session and SSE state. Navigation does not re-register collectors, reset queue state, or write device settings. On narrow screens, navigation becomes a compact horizontal strip. Service registration and credential windows stay usable at 360 CSS pixels.

Display has no connected badge, device identity, revision, TTL, ETA, state card, statistics grid, or permanent owner card. Selected queue rows may use a subtle visual highlight. Detailed state and actions appear only after opening a row. An unavailable or stale preview has a concise message inside its display area; it must never look like a fresh live screen.

## Queue semantics

Use a table with App, Sender, and Received columns. Preserve the server's scheduling/group order. A group opens to show all members. Opening a member exposes the existing pause, resume, end, and declared primary action controls, together with source/clock uncertainty. Collapsed rows have no notification title, detail, order number, severity badge, ETA, or action buttons.

Add an optional validated `app` string to publisher item metadata. The local agent adapter sends its task source (codex, dots, claude); notifier sends its actual app identifier. Existing publishers remain compatible. Missing app metadata displays the registered service's name/template, without guessing from notification text. App icon mappings use project assets; ADSBao uses its aircraft mark, not the unrelated Ads logo in the generated concept.

Sender is the registered service name and its instance when needed to distinguish hosts. It does not claim to identify the GitHub author or other business actor. Received is the existing server `receivedAt`, retained across updates to the same occurrence. A full timestamp is available in the time element's accessible label/title. The browser formats it in its local time zone.

## Actual display transport

Cloud scheduling and all display writes remain in the existing per-device Durable Object. The preview adds only a read path:

BUSY LAN framebuffer -> designated Mac read-only capture bridge -> authenticated Cloudflare ingest -> authenticated browser frame stream -> 72 x 16 pixel canvas.

Use the existing local Wi-Fi endpoint and Keychain credential. The browser and cloud do not receive the LAN password. The bridge's HTTP client only supports GET `/api/screen?display=0` and verifies the configured local device identity before streaming; it is not an arbitrary URL proxy. No drawing, input simulation, or firmware modification is part of capture.

A publisher can capture only after an administrator enables a separate `allowPreview` capability for its registered service. Only one active preview bridge lease per device/instance is accepted. The current input bridge can also be the preview bridge, but the two capabilities remain separate. The second Mac is not automatically enabled. Revocation, credential rotation, service disable, epoch expiry, or loss of bridge lease stops ingest and capture.

The Mac maintains a bounded authenticated upstream connection. The backend sends demand only while an authenticated, visible Display page is subscribed. Navigating away, hiding the tab, signing out, closing all viewers, or losing the cloud connection stops framebuffer requests. Multiple viewers share one acquisition path.

Capture uses a bounded set of interleaved persistent LAN GET connections paced to an aggregate target of 30 Hz. It validates and decodes the actual base64 BGR framebuffer. Late frames cannot replace newer captures. No catch-up bursts or unbounded pending requests are allowed. Raw pixels are sent in a fixed-size, versioned frame envelope with monotonic sequence, capture time and device/session binding. Server limits accept at most the target cadence plus a small bounded jitter allowance. Frame payloads never enter SQLite, audit records, logs, or static assets.

The backend keeps only the latest accepted frame in memory. Each viewer has bounded backpressure; old frames are dropped, not queued. Browser drawing uses animation frames with a 30 Hz ceiling and consumes only new sequence numbers. It never synthesizes motion or replays cached frames to claim 30 fps. A stationary clock may legitimately have identical pixels across fresh captures. Diagnostics distinguish capture rate, delivered fresh frames, draw rate, and content-change rate.

Actual rates depend on the LAN and internet. The acceptance target is approximately 30 fresh captures and delivered frames per second on a healthy connection, with measured jitter and latency. A lower observed rate is shown honestly in Device diagnostics and remains a performance issue to investigate, not a reason to relabel repeated frames.

The browser verifies the device identity and session generation on the preview path, just as it does for queue snapshots. An expired, replaced, or mismatched session cannot display another device's pixels. Preview access requires management authorization; an ordinary scoped publisher cannot read the whole device screen. Cloud reconnect retries use bounded backoff; authentication failures stop until credentials change.

## Visual system

Use the supplied native settings page's black background, neutral charcoal workspace, soft large corners, faint neutral borders, generous open space and compact controls. Use white text, muted neutral labels and BUSY red for the brand/primary action. Avoid decorative gradients, dashboard statistic cards and new marketing copy.

Desktop reference dimensions are 1536 x 1024. The side rail is about 280 pixels wide; the main workspace has a 32-pixel outer gap, 28-pixel radius and thin border. Center the device and queue on one shared axis. Keep the queue narrower than the main workspace, around 680 pixels. Rows are about 56 pixels high with quiet separators. Navigation rows are about 54 pixels high. Use a sans-serif UI face with 16-pixel body/control text, 14-pixel muted labels and restrained heading sizes.

The device shell is a separately generated asset with an empty screen opening. Draw actual device pixels above it, keeping the native 72:16 screen ratio. Do not ship the generated screen text as the preview. Rendering may use pixelated rectangles or circular LED cells, preserving pixel positions and colors; it must not interpolate numbers or invent status animation. Use original app marks from the repo for the queue.

Service and configuration pages reuse the shell, typography, forms and separators. The Services page contains registration/access, while Configuration contains policy edits. Existing revision conflict checks and unsaved-edit preservation remain intact. Errors remain visible and accessible without restoring the old information-heavy homepage.

## Research evidence, 2026-10-15

- Official HTTP docs describe display frame updates over WebSocket: https://docs.busy.app/bar/dev/http-api
- Firmware 1.2.4 `api_status_streaming.c` sets a 100 ms frame interval and an 11-packet/second limiter: https://github.com/busy-app/busybar-firmware/blob/1.2.4/applications/services/web_server/http_api/api_status_streaming.c
- The same firmware's `api_streaming.c` copies the current front framebuffer for each screen GET: https://github.com/busy-app/busybar-firmware/blob/1.2.4/applications/services/web_server/http_api/api_streaming.c
- A single device-token cloud WebSocket attempt returned 403. No authentication retry loop was used. This does not establish the capabilities of the separate BUSY account streaming API.
- Two interleaved 15 Hz LAN readers returned 90 frames in 3.02 s (29.8 fps) with no HTTP failure. A longer 10.02 s decode-validated run returned 268 frames (26.75 fps), 63 distinct pixel states, median request latency 35.6 ms and p95 interframe interval 116.3 ms. The longer run does not yet meet the sustained 30 fps target. Further acquisition and end-to-end measurements are required.
- Neither probe changed the firmware, simulated buttons, or replaced the production writer.

## Verification and release

Backend tests cover preview authorization and device isolation, stale/session/epoch/lease rejection, demand stopping, size/rate limits, reconnects and slow consumers. Metadata tests cover optional app fields, length validation, old stored items, and unchanged scheduling.

Python tests cover actual-frame decoding, local device binding, pacing and bounded in-flight requests, cancellation, authentication failure, demand loss, out-of-order completion, and no writes to device endpoints. Existing collector/action/urgent tests remain required.

Browser verification covers all four pages, real SSE updates across two tabs, row disclosure/actions, registration and credential access, policy saves/conflicts, session changes, hidden-tab suspension, desktop and 360-pixel layouts, keyboard/focus behavior and no horizontal overflow.

Compare the accepted concept and the browser screenshot with `view_image`, including palette, sidebar, workspace, device centering, queue density, typography, icons and responsive layout. Record intentional corrections to illustrative concept content. Keep real device screenshots private; public examples use labeled synthetic data.

Measure the production capture-to-cloud-to-browser path while native animation is running. Report fresh-frame count, actual rate, latency and gaps; independently inspect a received framebuffer and the visible canvas. Verify that all watchers leaving stops capture and that cloud scheduling continues. Do not claim completion from a local renderer benchmark or static screenshots alone.

Implement in the isolated `feat/control-plane-ui` worktree. The real service continues from the stable main checkout until the change is reviewed and ready. Run Python tests, Worker/UI tests, typecheck, Vite build, and deployment dry-run; review the final diff and publish a PR before production rollout. Update the Chinese and English guides with the real preview dependency and bridge setup.
