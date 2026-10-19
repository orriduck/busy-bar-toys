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
The observer records cumulative input and output totals.
When Codex supplies an attributed `token_usage_record` with `turn_token_usage`
and the matching `task_complete.duration_ms`, the checker shows the latest
completed **turn average** in tokens per second. This is a whole user-request
turn, including tools, waiting, thinking, first-token latency and retries.
It is not a single-reply or model decoding speed. Input excludes cache reads;
output already includes reasoning tokens, which are not added again.
The display truncates fractional tokens per second; 938 output tokens over
37,000 ms therefore shows `25`.

Both records must identify the same thread and turn. The parser uses the latest
per-turn snapshot, so duplicate responses are not summed. A new running turn
holds the last completed value; an unmeasurable new completion clears it to `--`.
Missing usage or duration, non-positive duration, counter resets, conflicting
response records, interruption and failure produce `--`. Legacy `token_count`
thread totals and app-server `tokenUsage.last` are never treated as turn usage.
An explicit attributed per-turn snapshot can remain valid across compaction;
copied records from another thread cannot supply a fork's usage.
It does not store prompts or tool output.
Subagents do not get separate display entries.
A failed tool command does not mean that the task failed.

Browser ChatGPT conversations are not monitored.
Local Codex log formats can change after an update.

This parser does not install hooks, start a daemon, change permissions, or add a
new subscription. Environments that prohibit session-directory access must not
read those files to obtain throughput. An already authorized metadata-only feed
can call `CodexTaskRegistry.ingest` with the records; no such live feed is enabled
by this change. Without an allowed producer exposing both fields, live speed
remains unknown. A local synthetic watcher test verifies the supported input
path, not the availability of real usage on the current Mac.

The field attribution is defined by OpenAI's
[TokenUsageRecord change](https://github.com/openai/codex/commit/5f79a92e3936274318d2122ae3244e5edd80dd1f),
and the millisecond duration comes from its
[monotonic turn timer](https://github.com/openai/codex/blob/e4568a3538c9cab6627d64ff8cdfc7d98b79b7db/codex-rs/core/src/turn_timing.rs).
The [app-server protocol](https://developers.openai.com/codex/app-server) exposes
turn lifecycle events, but merely finding its schema does not establish access
to an existing Desktop event stream.

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
