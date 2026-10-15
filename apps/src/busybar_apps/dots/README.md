# Your dot agent app

Show the status of Your dot tasks on the agent checker.
The source icon has five points. The source identifier is `dots`.

## Requirements

- Codex Desktop with local Orbit state in `~/.codex/.codex-global-state.json`, or
- An external tool that runs `busy-bar emit` on this Mac.

## Identify Your dot tasks

The service reads explicit Orbit thread identities from the local Codex state every minute.
Identity alone does not indicate activity.
Use `watch --dot-thread THREAD_ID` for a manual identity override.

## Send lifecycle events

Cloud-only Your dot tasks need an event bridge to this Mac.
Use one session ID and one turn ID for each real task turn.

```sh
.venv/bin/busy-bar emit working --source dots --session-id THREAD_ID --turn-id RUN_ID --project my-project
.venv/bin/busy-bar emit waiting --source dots --session-id THREAD_ID --turn-id RUN_ID --project my-project
.venv/bin/busy-bar emit done --source dots --session-id THREAD_ID --turn-id RUN_ID --project my-project
```

The commands write local metadata. The observer sends the display data.
Your dot uses the same hook mapping as the [Codex app](../codex/README.md).
