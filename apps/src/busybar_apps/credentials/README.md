# Credential notifier app

Show one standing item, `CRED EXPIRE`, that lists every login that needs renewal.

## Configure

Each check is a command or a timestamp file.

```json
{"credentials": {"every": 120, "checks": [
  {"name": "gh auth login", "command": ["gh", "auth", "status"]},
  {"name": "vendor login", "command": ["vendor", "auth", "check"], "expect": "Valid"},
  {"name": "token refresh", "stamp": "~/.cache/token-stamp", "max_age_hours": 12}
]}}
```

| Key | Meaning |
|---|---|
| `name` | The text on the display. |
| `command` | Valid when the command exits with code 0. |
| `expect` | Optional. The output must also start with this text. |
| `stamp` | A file that contains a Unix time. Valid when it is newer than `max_age_hours`. |
| `every` | Seconds between checks. The default is 120. |

The item clears when every check is valid.
The app does not run any login command.
