# Datadog notifier app

Show on-call pages and alerting monitors for one Datadog team.

| Item | Level | Title |
|---|---|---|
| Triggered on-call page | urgent | `PAGED!` |
| Monitor in the Alert state | attention | `MONITOR` |

Press Start/Pause on a visible page to acknowledge it in Datadog.

## Requirements

- The [pup](https://github.com/DataDog/pup) command-line tool, signed in with `pup auth login`.
- Permission to read on-call pages and monitors. Acknowledgement needs on-call write permission.

## Configure

```json
{"datadog": {"team": "my-team", "monitor_tags": "team:my-team,env:prod", "monitors": true}}
```

| Key | Default | Meaning |
|---|---|---|
| `team` | required | The on-call team handle. |
| `monitor_tags` | `team:TEAM,env:prod` | Monitor tag filter. |
| `monitors` | `true` | Set to `false` to show pages only. |

Pages are checked every 30 seconds and monitors every 60 seconds.
