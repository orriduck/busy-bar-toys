# Terminal notifier app

Show when a long command finishes.

| Result | Level | Title |
|---|---|---|
| Exit code 0 | info | `DONE` |
| Other exit code | attention | `FAILED` |

The detail line shows the command and its duration.

## Use

Enable the app with `{"terminal": {}}`, then run a command through `busy-bar`:

```sh
.venv/bin/busy-bar run -- make test
```

The command runs in the foreground and keeps its exit code.
A private note in the runtime `inbox` directory carries the result to the service.
The note contains the first 200 characters of the command line.
