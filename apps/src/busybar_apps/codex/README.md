# Codex agent app

Show the status of local Codex Desktop and CLI tasks on the agent checker.
The source icon is the ChatGPT mark. The source identifier is `chatgpt`.

## Requirements

- Codex Desktop or the Codex CLI on this Mac.
- Local rollout files in `~/.codex/sessions`.

No configuration is necessary. The service reads new rollout lines every second.

## Task events

The observer reads local Codex Desktop and CLI lifecycle events.
It extracts identifiers, source, project directory name, timestamps, and reported token counts.
The observer records the session's cumulative input and output totals.
The agent checker turns them into tokens per second.
It does not store prompts or tool output.
Subagents do not get separate display entries.
A failed tool command does not mean that the task failed.

Browser ChatGPT conversations are not monitored.
Local Codex log formats can change after an update.

## Optional Codex hooks

Hooks report state changes immediately.
`busy-bar hook` reads structured hook data from standard input.

| Hook | State |
|---|---|
| UserPromptSubmit, PreToolUse, PostToolUse | working |
| PermissionRequest | waiting |
| Stop | done |
| Interrupt | stopped |

Add a handler to each required event in `~/.codex/hooks.json`.
Replace the example path with the absolute repository path.
Keep all existing hooks.

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/ABSOLUTE/PATH/busy-bar-toys/.venv/bin/busy-bar hook",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

Review and trust new hooks through the normal Codex process.
The program does not change hook trust records.

## Icon notice

See the [icon notices](../NOTICE.md).
