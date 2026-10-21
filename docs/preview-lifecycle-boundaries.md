# Preview lifecycle and latest-frame boundaries

This is a local refactor only; no deployment or protocol migration is needed.

- `PreviewBridge` is still the single optional preview publisher for local roles.
  It owns cloud authentication and reconnect/backoff policy, capability checks,
  demand, LAN validation, display fences, generation tokens and diagnostics.
- `preview_session.supervise_preview_session` owns only the lifetime of an
  authenticated session's receive, send, capture, heartbeat, permission and
  diagnostic tasks. The first task ending ends the session. It invokes the
  bridge's invalidation callback before cancelling and joining siblings, on
  normal exit, error or cancellation. It does not acquire another publisher
  lease, reset reliable state or reconnect on its own.
- `preview_pipeline.LatestFrameBuffer` owns the lossy pending-frame handoff.
  Capture offers never block: at most one pending frame survives. Same-generation
  older completions cannot displace newer pending frames. An already-sent
  sequence is dropped. A changed generation can restart sequence numbering.
  The caller must reject stale generations before offering; generation tokens
  are not ordered by the buffer. Dequeued frames are not retained or replayed.

These are different contracts from the reliable service queue: replacing or
invalidating preview pixels must not acknowledge, end, delete or retry a service
occurrence. Neither new preview module imports service queue or transport state.
There is no shared retry budget between frames, sessions and service delivery.

The bridge still checks permission/demand/generation/display state before
capture, on completion, before send and after send. Invalidation cancels an
active send and discards queued pixels. HTTP reads remain shielded and bounded;
2 FPS capture cadence, one in-flight device read, wire message schema and
single-publisher selection are unchanged. Preview uses the existing publisher
socket; this extraction does not rename or reverse a network direction.

This stage does not extract the full bridge coordinator, change browser playout,
change service-queue persistence, or move reconnect classification into a generic
connection manager. Those are separate changes and should not be conflated with
this task-lifetime/buffer boundary.

## Local contract checks

- `shared/tests/test_preview_pipeline.py`: capacity-one supersession, ordering,
  generation reset/discard, waiter/instance isolation and session teardown.
- `shared/tests/test_preview.py`: existing LAN safety, permissions, demand,
  display fencing, capture cadence, retry/backoff and diagnostic regressions.
- `service/tests/test_cloud_preview.py`: exactly one optional bridge lifecycle.
- Existing control-plane preview tests cover unchanged wire/browser behavior.


## Subsequent fault isolation

The coordinator now bounds the display-confirmation pause to two seconds, then
reads unconfirmed actual pixels at0.5FPS. Frames carry an optional boolean
`displayConfirmed`, preserved by the relay and labeled by the browser. Confirmed
reads retain2FPS and one in-flight read. These changes do not affect the extracted
session/buffer owners or service-queue delivery evidence. Deploy the relay before
the new bridge; see `preview-device-priority.md` for upgrade/rollback order.
