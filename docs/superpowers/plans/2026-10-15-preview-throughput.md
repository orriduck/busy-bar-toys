# Real preview throughput recovery

> Execute with subagent-driven-development: implementation, spec review, quality review, then actual acceptance. Do not mark the30fps goal complete from synthetic timing alone.

## Evidence

Production25.282s counter delta:527 requests,529 completions(window edges),491 sends, zero capture errors/busy skips. SSE482 frames over25.462s, one stream, about19.39fps. Native CPU sample: process near95% one core; preview thread waits on GIL; notifier publisher spends substantial time JSON encoding. Local notifier state is about11MB with118 completed occurrences. Private isolated replay of its data with no transport/live writes: snapshot without tombstones saves once/50ms; same snapshot carrying118 already-processed tombstones saves119times/5887ms (5722ms CPU). No process-attachment permission was available; do not bypass OS permissions.

## Task 1: Make terminal receipts idempotent

Files: shared/src/busybar_shared/cloud.py, shared/tests/test_cloud.py.

- Write a failing regression for repeated accepted tombstones (including same and newer snapshot revision): one durable terminal transition, no rewrite or callback for unchanged terminal data. Observe actual state.save/callback counts, without sleep/time-threshold tests.
- Preserve first transition, compaction, ack/version advancement, changed terminal reasons, cleared-source behavior, pending urgent fallback/title/detail, notification dedupe and restart/replay protection. State.tombstone must report whether it actually changed a matching record. Compare the exact resulting record if necessary; a shallow prior copy is enough because this function changes top-level fields only.
- Producer.accept must invoke on_tombstone only for actual receipt transitions, after durable save. A repeated clear receipt must not dismiss a subsequently started task. Preserve device/service/instance/epoch fencing.
- Keep unrelated state persistence/asset accounting, watcher/capture scheduling and network protocols unchanged for this isolated fix.
- Run focused tests and full Python suite. Independent spec review, then quality review.

## Task 2: Actual acceptance before further fixes

- Repeat offline private replay and actual production profile. Establish actual request/send/receive/draw rates, CPU and reconnect behavior; do not present runtime averages spanning idle time as current FPS.
- Install reviewed code in the stable checkout and restart cloud service. Preserve role credentials, capabilities, Wi-Fi input and other Mac. If still below30fps, keep goal active and use evidence to select the next bottleneck.
- If capture timer drift remains, use measured timer/worker-start distributions and a regression before changing cadence. Do not send catch-up bursts, exceed four HTTP reads, weaken deadlines/fences or invent frames.

## Release

PR, latest-head CI, merge, stable main synchronization, production/UI verification as applicable. Update issue13/verification ledger and canonical project memory with actual evidence and boundaries. Do not modify the already accepted layout.

## Task 1 verification

Implementation d57efc5 (same code as independently reviewed941edaa): State.tombstone compares resulting records, persists transitions, rolls back matching in-memory records when save fails, and reports change to Producer.accept. Identical receipts do not invoke source callbacks. Independent specification and quality reviews passed;32 focused cloud tests and325 full Python tests passed in isolated review. Regressions failed before the fix.

Private offline replay after the fix, using the same production-state size and118 historical receipts:1 save,76.59ms wall/74.42ms CPU. The no-receipt control took52.41ms. This establishes duplicate-work reduction only; production30fps remains unverified until post-install acceptance.

## Post-install production result

PR19 merged at main0632ff2; stable Mac editable install refreshed and cloud launchd service restarted. Both scoped roles returned healthy/demo:false. PID70937 is an observation only. CPU sampled6.4–8.0%, compared with pre-fix90.6%. Actual25.641s read-only SSE sample:523 frames, two streams,20.904fps; producer window25.791s requested22.876/s, sent21.132/s, two capture errors, five busy skips. A timeout/reconnect caused a1.815s maximum arrival gap. Formal browser over27.14s received20.19/drew19.42fps and changed streams. These different network windows do not prove a controlled FPS improvement; stable30fps remains unmet.

## Task 3: Preserve bounded capture cadence

A separate six-second background-thread benchmark of the actual _capture loop with no LAN or frame work produced174 ticks/28.943Hz, median34.431ms, p95 36.384ms, max39.443ms. Positive wake lateness accumulates because each tick resets the deadline from its actual start. Actual pipeline still has additional request-completion and reconnect losses; cadence is one measured contributor only.

Files: shared/src/busybar_shared/preview.py, shared/tests/test_preview.py. Use subagent implementation, spec review and quality review. Add a deterministic regression for bounded positive wake jitter that fails under reset-from-now scheduling. Preserve the30Hz phase where possible, with at least25ms between submitted ticks, no missed-tick bursts, at most one read per tick and four outstanding reads. Long stalls skip missed deadlines; invalidation, identity, no-demand and reconnect reset the schedule safely. Preserve existing300ms total HTTP deadline and all authentication/session/generation fences. Avoid OS priority changes or catch-up batches. Add bounded aggregate timing counters only if they provide necessary acceptance evidence; never record raw pixels, source content or credentials.

Run focused preview/full Python tests, two-stage independent review, then actual read-only production acceptance after normal PR/CI/merge/install. No synthetic result alone satisfies the30fps goal.
