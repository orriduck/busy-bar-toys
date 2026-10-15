# Control plane verification ledger

Baseline: main@93e0688. Worktree has its own editable Python environment; baseline 223 tests passed (2026-10-15). The original macOS service has not been replaced.

## Required before the local implementation is ready

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

## Separate release checks

Real Cloudflare deployment and real-device migration are not covered by local mock tests. Cloudflare login expired; user is away and directed local development. No device token rotation, real-device writes or launchd reinstall as part of this iteration. Both Macs must be prepared before revoking old direct-writer tokens. Preserve the old checkout/Keychain identities until a reviewed migration is possible.
