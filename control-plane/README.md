# BUSY Bar control plane (local MVP)

This Worker and per-device SQLite Durable Object implement the approved [v5 design](../docs/plans/control-plane-v5.md). The browser manages service policy and the current full queue; scoped local producers provide complete scenes, hashed assets, heartbeats, actions and optional physical input. The backend is the only cloud display writer. See [PROTOCOL.md](PROTOCOL.md) for the exact wire contract.

## Run the isolated local demo

Requires Node26/npm. In this directory:

```sh
npm ci
npm run dev:demo
```

Open `http://localhost:8787`; sign in with **demo-token**. Only this explicit demo configuration binds the mock BUSY service; `/api/mode` and snapshots report `demo:true`. The mock never forwards a request to BUSY. `demo-blocked` and `demo-offline` verify the same fake device identity but simulate display conflict/offline. The mock counters are at `http://localhost:8790/__demo/state`. Local state is retained under ignored `.wrangler/`; stopping the process pauses the local simulation. No deploy, real device writes or credential rotation are performed by these commands.

The production config has no `BUSY_UPSTREAM` binding and always addresses `https://api.busy.app/busybar`. A real BUSY token entered into the demo is rejected. Demo encryption/signing strings are public fixtures and must never be copied to production.

## Checks

```sh
npm test
npm run typecheck
npm run build
npm run dry-run
npm run types
```

Tests run in Cloudflare's Workers Vitest runtime, with fake HTTP only. They cover stable scheduling, pause/resume, urgent FIFO, grouping/admission, actions, input grants, projection privacy, allowlists, bounded assets, SQLite storage beyond2MiB aggregate, alarms, successful-command actual eviction, uncertain-command constructor reconstruction, blocked upstream and serialized generation correction. They do not establish physical pixels, animation timing, production availability, dual-Mac migration or token revocation acceptance. Wrangler may warn that production required secrets are absent during tests; the test configuration explicitly supplies public fixture values to Miniflare.

## Operator setup after local review

Deployment and device migration remain separate authorized steps. Before a real deployment set `PUBLIC_ORIGIN` in `wrangler.jsonc` to the exact HTTPS management origin, provision a fresh64hex AES256 secret as `TOKEN_ENCRYPTION_KEY`, and a separate random signing secret as `SESSION_SIGNING_KEY` using Wrangler secret bindings (`wrangler secret put NAME` reads stdin). Never pass a real secret in argv, commit it, or log it. Regenerate binding types with `npm run types` after config changes. Production logs/traces are enabled; application code logs no notification bodies or upstream responses.

The device token is verified via `/status.device.serial_number`, encrypted with random-IV authenticated AES-GCM, and stored only in its derived device DO. Browser sessions are12h Secure/HttpOnly/SameSite=Strict cookies; mutations enforce Origin. Register agent/notifier/custom services using the current config revision. Save each returned publisher credential and stable epoch once in the local client's credential store; never paste it into a command line. Epoch/credential survive process restart and expire after30days. Reissue invalidates the former credential/epoch and ends its items. Ordinary publishers cannot modify service policy or receive other services' bodies. Grant `config.allowInput` only to the designated trusted physical input listener; that grant allows device-wide Start/Pause handling, without broad content access.

Policy defaults: enabled, priority50 (range0..1000), visible10s (1s..24h), condition snooze30min (1s..24h), heartbeat timeout90s (5s..5min), `exit:default`. Default urgent and agent items remain until source end; other events are finite. Explicit `exit:finite` also limits urgent items, `exit:source` is indefinite. Native firmware priority is fixed50 and independent of service ranking.

## Recovery and resource bounds

State and command intent are committed before external HTTP; one dispatcher checks generation immediately before every request and waits for that bounded8s request before correcting an obsolete result. SQLite stores items/assets/actions/tombstones/commands in independent bounded rows. Alarms drive expiry, entry offsets, snooze, renewal, action uncertainty, cleanup and exponential retry. Successful commands are not replayed after eviction. An uncertain persisted in-flight command starts a new generation, clears only the platform namespace, then restores the latest full scene with prior elapsed visible time deducted. External side effects remain local and must use durable action-ID dedupe; unknown results are not a license to repeat them.

Limits per device:32services,256liveitems/2MiB presentation JSON,4096 live-item plus tombstone reservations,512actions,2048button IDs,64sessions and16SSE connections. Tombstones retain identity/version through epoch expiry, preventing replay after body deletion. Cloud asset cache64files/4MiB,256KiB per asset; unused assets are removed after1h or LRU pressure. Device pool16filenames/2MiB; occupied slot extensions are immutable, playing/pending slots are pinned. If every slot was initialized with one type, introducing a different type can return capacity until a new namespace/device-pool migration; files are never silently multiplied or overwritten while playing. Full replay reloads from bounded cloud cache. Native text TTL never exceeds60s; short finite text is sent once, longer text renews near45s separately from ordinary widgets. Same-content versions/heartbeats do not restart scrolling.

The first release sends current full SSE snapshots on connect/change/reconnect, including pending actions and finite display/queue/coverage proofs. Slow consumers close and reconnect; no historical replay or screen capture is implemented. A successful BUSY draw response is API acknowledgment, not pixel readback. Cloud failure has no local direct-write fallback; existing limited native TTLs eventually return the Bar to its own calendar. The producer's independent urgent watchdog and OS notification fallback must be enabled and verified during the later two-Mac migration.

Official API/runtime references checked2026-10-15: [Workers test integration](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/), [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [SQLite row/resource limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/). The BUSY request/element shapes were checked against the locally saved API27.5.0 OpenAPI document and existing Python client; physical firmware acceptance remains pending.
