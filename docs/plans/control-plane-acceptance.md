# Control plane verification ledger

Baseline: main@93e0688. Worktree has its own editable Python environment; baseline 223 tests passed (2026-10-15). The original macOS service has not been replaced.

## Local verification

2026-10-15: 279 Python tests and 49 Worker/UI tests pass. TypeScript, Vite build, production dry-run and both preview dry-runs pass. The new Swift helper compiles; it was not invoked against Keychain. CLI help and local Markdown links were checked. Python 3.10 syntax was parsed; its runtime matrix is checked in GitHub CI.

Backend, Python and UI spec/quality reviews passed after focused fixes. Regressions include bounded64-element batches, actual TTL expiry, clear-only ACK coverage, transient masks and recovery scenes, session/device fences, fail-closed collector setup mode, interrupted actions, expired urgent fallback, sleep/clock changes, aircraft rearm, partial HTTP bodies, asset eviction/concurrent LRU, revoked input grants and urgent recognition before rendering.

| Surface | Evidence required |
| --- | --- |
| Persistent scheduling | urgent FIFO/no mutual preempt, grouped members, finite pause/resume, standing snooze, clear tombstones, stale version/generation and restart |
| Credentials and isolation | verified device identity, ciphertext at rest, cookie security/same-origin writes, publisher service scope, no other-service content in snapshots |
| Dispatcher | fixed API boundary, no redirects, one writer, durable commands and recovery, bounded assets/pinning, text TTL and no short text replay |
| Actions and buttons | pending resync, durable local dedupe, unknown side effects not retried, late success cannot clear new target, clear nonurgent queue |
| Urgent fallback | no notice while valid healthy urgent queue proof, proof expiration/disconnection fallback, original deadline survives restarts, deduped notices |
| Browser | actual local Worker with mock BUSY upstream, SSE refresh in two clients, services policy/revision conflict, grouped event queue, errors and mobile layout |
| Existing behavior | Python suites use worktree imports, no Claude hooks installed, standalone defaults preserved |
| Package/release | Worker types/tests/dry-run, Python tests, bilingual setup/recovery docs, clean review and PR |

The real local Worker integration passed native selected updates, urgent preemption, one local action execution, latest agent recovery and scoped SSE. Browser verification is recorded in [the UI ledger](control-plane-ui-verification.md).

## Cloud preview verification

After the user completed Cloudflare authorization, deployed [the isolated preview](https://busy-bar-control-plane-preview.orriduck.workers.dev) in the Orriduck account. `wrangler.preview.jsonc` binds a private `busy-bar-control-mock-preview` Worker; it has no public route, no network egress and accepts only fake device tokens. Production `wrangler.jsonc` remains separate. Fresh secret values entered Wrangler through stdin, not Git, arguments or logs.

Remote HTTPS login, Secure session, SQLite persistence across redeployment, two-page SSE policy synchronization, a synthetic action with running/succeeded results, urgent handoff, group expansion and pause were verified. After closing both management pages, the source fixture continued; the timed group ended, Codex resumed, and the paused flight stayed paused. This confirms browser-independent operation with a live synthetic source; it does not simulate every source being offline. The Python client's explicit application User-Agent was verified against the hosted endpoint after the default urllib marker received403.

## Separate production release checks

Production deployment and real-device migration remain pending. No real BUSY token rotation or launchd reinstall was performed. Both Macs must be prepared before revoking old direct-writer tokens. Preserve the old checkout/Keychain identities until a reviewed migration is possible. Mock API acknowledgment does not verify firmware pixels, native animation timing or OS notification permission. Full abrupt-process crash acceptance remains separate; persisted uncertain intent reconstruction and actual acknowledged-object eviction are covered locally.
