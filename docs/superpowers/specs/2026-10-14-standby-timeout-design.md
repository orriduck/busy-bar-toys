# Standby returns to the native calendar after ten seconds

User direction: after the final standby display, wait ten seconds and return to the device's original calendar.

Start a monotonic ten-second timer only after the full-height white standby is successfully drawn. Idle, completion and interruption share one uninterrupted standby interval, so a done-to-idle transition or a five-second refresh does not restart it. Working, approval waiting, errors or unknown status cancel the interval. New activity before the deadline keeps Codex visible and a later standby starts a fresh interval.

At expiry, use the existing persisted calendar dismissal and query-scoped clear. Stop all further overlay refreshes until a new turn appears. Check expiry each observer iteration, not just the five-second draw interval. This automatic route uses existing cloud display access and needs no physical-button stream.

Validate exact timer boundaries, refresh continuity, new work cancellation/rearm and native-calendar/new-turn behavior through the production observer. Keep previous Start/Pause transport limitations explicit.
