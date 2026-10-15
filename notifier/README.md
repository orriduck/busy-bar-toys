# Notifier

Show short alerts on a BUSY Bar with the staggered character entrance from ADSBao.
The icon flies in, the brand holds for half a second, and the characters roll to the title.
The detail line always appears as native small text after the entrance and scrolls when it does not fit. A title that does not fit continues as native scrolling text. Native text shows printable ASCII only; other characters become `?`.

## Levels

| Level | Detail and LED color | Hold for a new event | Start/Pause |
|---|---|---|---|
| urgent | Red | Until the condition clears | Runs the app action, for example a page acknowledgement. |
| attention | Amber | Ten seconds | Dismisses all notifications and shows the calendar. |
| info | The app accent | Ten seconds | Dismisses all notifications and shows the calendar. |

The icon background uses the app color. Urgent items use a red background.

Urgent items show first, then new events, then standing conditions.
An urgent action dismisses its item only after success.
A failed action leaves the item visible for another attempt.
Repeated presses do not start duplicate actions while one is running.
A standing condition, such as an expired login, hides after ten visible seconds.
It returns after 30 minutes if it is still true.
No button press is necessary: the display returns to the agent view or the calendar.
Items in one group, such as one pull request, show once at the highest level.
When a condition check fails, an `ERROR` item replaces its old items.

The agent view or the device calendar returns when the queue is empty.

## Share one Bar between Macs

Several Macs can use one Bar.
The Mac that shows a notification writes a display lease to device storage.
The lease contains a host identifier, a level, and an expiry time 20 seconds ahead.
The holder renews the lease every five seconds.

| Situation | Behavior |
|---|---|
| Another Mac holds the lease | Non-urgent items wait in the queue. The agent view does not draw. |
| An urgent item arrives | It takes the lease from a lower-level item. Another urgent item keeps its lease until release. |
| A holder stops or loses its connection | The lease expires after 20 seconds. |

Every Mac must run this version for the lease to work.
Agent-only hosts also check the lease before drawing.
Start/Pause checks current ownership before an action.
An ownership read failure prevents the action and skips display cleanup.

## Configure

Every app is off until the private file `~/Library/Application Support/BusyBarAI/notifier.json` enables it.
Each top-level key enables one app. Keep this file out of Git.

```json
{
  "datadog": {"team": "my-team"},
  "github": {"org": "my-org", "team": "my-team", "ignore_authors": ["my-bot"]},
  "jira": {},
  "metaflow": {"python": "~/.venvs/metaflow/bin/python", "flows": ["TrainingFlow"]},
  "terminal": {},
  "credentials": {"checks": [{"name": "gh auth", "command": ["gh", "auth", "status"]}]},
  "calendar": {"lead_minutes": 2},
  "display": {"hold_seconds": 10, "snooze_minutes": 30}
}
```

The optional `display` key sets the hold of non-urgent items and the snooze of standing conditions.
See the README of each app for its requirements and keys.
Restart the service after a change: `.venv/bin/busy-bar install`.

## Commands

| Command | Purpose |
|---|---|
| `.venv/bin/busy-bar run -- COMMAND` | Run a command, then show DONE or FAILED. |
| `.venv/bin/busy-bar notify-demo` | Play one labeled sample of each notification. Stop the service first. |
| `.venv/bin/busy-bar status` | The `notifier` key lists the enabled apps. |

## Privacy

Notification sources run local command-line tools with the user's own credentials.
Seen-item records stay in the private runtime directory.
The device receives display images, text, and the display lease.
