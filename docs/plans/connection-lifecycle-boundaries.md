# Connection lifecycle boundaries

This is an incremental in-process split. It does not introduce a daemon, merge
physical connections, change queue persistence, or change preview ownership.

## Direction and endpoints

Use the product's terminology: **uplink** is content sent by the machine to
Busy; **downlink** is service information obtained from Busy. In the current
cloud implementation, service state comes from BTC, not directly from the
physical Bar. The path is:

- Content: local producer → BTC `/api/publish`, `/api/update`, `/api/assets` →
  BUSY cloud API device draw operations.
- Service information: BTC `/api/events` and `/api/snapshot` → local producer.
- Preview pixels: physical device LAN screen read → local bridge → BTC preview
  WebSocket → browser preview stream. This transport upload does not make pixels
  equivalent to durable business content.

If “Busy” means only the physical device, rather than this whole service, that
mapping must be clarified before moving device adapters. This change touches
only the unambiguous local-producer/BTC boundary.

## State ownership and contracts

| Component | Owns | Does not own |
| --- | --- | --- |
| Content uplink (`Producer.flush`) | Ordered durable outbox, immutable retry payload, occurrence/version, business acknowledgement | Snapshot polling/reconnect policy |
| Service state owner (`Producer.accept`, `State`) | Revision order, tombstones, admission evidence, persistent occurrences and acknowledgements | Socket lifetime or retry timer |
| Lifecycle (`PeriodicChannel`, `SnapshotStreamChannel`) | Per-channel retry budget, stop behavior, terminal-error handling | Queue, occurrence, ack, persistence, frame cache |
| Presence lane | Empty `itemIds=[]` check-ins | Item renewal, queue reconciliation, callbacks |
| Preview bridge (unchanged) | Demand, stream/generation fence, one latest frame, capture safety | Durable delivery of frames or business acknowledgement |

A channel disconnect/EOF never calls `end`, clears the queue, creates an ack,
or replaces occurrence identity. Snapshots are transported to a separate owner;
the owner serializes complete reconciliation across SSE, polling and response
snapshots. A stale/missing projection is not authoritative absence for expired
unacknowledged-content recovery.

Frames deliberately have different reliability: stale frames may be discarded
and replaced; business content must retain its durable identity and confirmation.
Do not unify their queues or retries.

## Implemented stages

1. Independent presence worker. It does not take business state locks or execute
   reconciliation callbacks. Concurrent request diagnostics retain each request.
2. Extract lifecycle mechanics into `connection_lifecycle.py`. Uplink flush,
   downlink SSE, downlink fallback poll and presence use separate lanes and retry
   budgets. Downlink polling no longer waits behind asset/publish I/O, and an
   initial blocked poll no longer blocks ordinary new content.
3. Protect business preconditions at this boundary: full snapshot reconciliation
   is serialized by its owner; expired frozen-body version recovery requires
   fresh authoritative absence and a still-live occurrence.

The `Producer` remains the composition root and business state owner. These
steps do **not** claim that all queue implementation has moved into its own
module, or that preview transport/rendering has already been refactored.

## Remaining work

- Extract a dedicated ServiceQueue interface from the existing state owner,
  without changing schema or lifecycle behavior. Preserve durable queue/ack on
  process restart, disconnect, duplicate snapshots and cancellation.
- Extract preview session supervision from frame rendering/capture only after
  contracts cover permission revocation, generation invalidation and late frame
  completion. Keep one-frame lossy buffering, separate from durable content.
- Version business item renewal before making it concurrent with publishing.
  Current server heartbeat assigns item `validUntil`; an old delayed renewal
  could shorten a newer publish. Empty presence cannot do this.
- Consider monotonic presence scheduling, per-lane health reporting and avoiding
  redundant healthy check-ins. Do not optimize by restoring a shared blocking
  lane.
- Improve bounded lease/retry evidence for preview 409 responses without relaxing
  the single-publisher constraint. No production root cause is asserted here.

## Validation contracts

Tests cover independent retry budgets, terminal auth, EOF reconnect, both
blocked-direction permutations, unchanged durable state across stream loss,
freshness-gated expired-body recovery and serialized snapshot reconciliation.
Existing item, action, freshness, replay, asset and preview suites remain in the
full test run. No credentials or physical device are needed for these tests.
