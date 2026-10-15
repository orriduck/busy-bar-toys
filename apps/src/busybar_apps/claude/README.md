# Claude Code agent app

Show the status of local Claude Code sessions on the agent checker.
The source icon is the official Claude mark as a white mask; see [NOTICE](../NOTICE.md). The source identifier is `claude`.

## Requirements

- Claude Code on this Mac.
- Hooks in `~/.claude/settings.json` that run `busy-bar hook --source claude`.

## Hook mapping

| Hook | State |
|---|---|
| UserPromptSubmit, PreToolUse, PostToolUse | working |
| Notification with `permission_prompt` or `elicitation_dialog` | waiting |
| Stop | done |
| SessionEnd | stopped |

Other notifications, such as the idle reminder, do not change the state.
Claude Code hook payloads have no turn identifier.
Each `UserPromptSubmit` starts a new local turn.
Later events in the session reuse that turn.
Only a new turn restores a dismissed display.

## Add the hooks

Add one handler to each event in the table.
Replace the example path with the absolute repository path.
Keep all existing hooks.

```json
{
  "hooks": {
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "/ABSOLUTE/PATH/busy-bar-toys/.venv/bin/busy-bar hook --source claude", "timeout": 3}]}],
    "PreToolUse": [{"hooks": [{"type": "command", "command": "/ABSOLUTE/PATH/busy-bar-toys/.venv/bin/busy-bar hook --source claude", "timeout": 3}]}],
    "PostToolUse": [{"hooks": [{"type": "command", "command": "/ABSOLUTE/PATH/busy-bar-toys/.venv/bin/busy-bar hook --source claude", "timeout": 3}]}],
    "Notification": [{"hooks": [{"type": "command", "command": "/ABSOLUTE/PATH/busy-bar-toys/.venv/bin/busy-bar hook --source claude", "timeout": 3}]}],
    "Stop": [{"hooks": [{"type": "command", "command": "/ABSOLUTE/PATH/busy-bar-toys/.venv/bin/busy-bar hook --source claude", "timeout": 3}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "/ABSOLUTE/PATH/busy-bar-toys/.venv/bin/busy-bar hook --source claude", "timeout": 3}]}]
  }
}
```

The hook writes metadata only: session and turn identifiers, the state, the project directory name, and a timestamp.
It does not store prompts, tool input, or tool output.
