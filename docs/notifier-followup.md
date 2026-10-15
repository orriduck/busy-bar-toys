# Notifier follow-up — 2026-10-15

The baseline is merged PR [#2](https://github.com/orriduck/busy-bar-toys/pull/2),
commit `cf1cbd1`. Its 213 tests passed before this review.

## Findings and changes

- An urgent action could run after another Mac took the display. Start/Pause now
  reads ownership again before acting and abandons a stale local presentation.
- A failed acknowledgement hid its urgent item indefinitely. Action results now
  return to the coordinator. Only success dismisses the item. Pending identifiers
  prevent duplicate submissions; failure permits a later retry.
- Agent-only hosts did not read the lease. All hosts now read it, even when no
  local notifier source is enabled.
- Shutdown could clear a foreign host's view. Cleanup now checks ownership and
  completes before releasing the local lease.
- Two urgent hosts could repeatedly preempt each other. The current urgent
  holder keeps its lease. Urgent items still preempt lower levels.
- Reduced-motion dismissal left native title and detail widgets above the next
  view. Both animated and static exits now hide these text widgets.
- A failed lease read looked like an absent lease. Only the documented missing
  storage responses, HTTP 400 and 404, permit missing-file recovery. Transport,
  authentication, and unexpected server errors now prevent an action or clear.

## Verification

All 222 tests passed. The added service tests use the production coordinator,
queue, presenter, and lease with fake clocks and device storage. They cover agent
hosts without sources, takeover before a press, takeover before shutdown,
failed and successful actions, equal urgent contention, and failed ownership
verification. Presenter tests cover static text cleanup.

The original 213 tests continue to cover agent status, Claude hooks, native
animations, aircraft filtering and restoration, notification adapters, queueing,
retry delays, and private credential handling.

The action tests use mocks. They do not acknowledge a real page or change an
external service. Optional sources remain controlled by private configuration.
