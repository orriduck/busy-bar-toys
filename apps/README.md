# Apps

Each app is one subpackage of `busybar_apps`.
Agent apps register a profile with the [agent checker](../agent-checker/README.md).
Notifier apps return notification sources for the [notifier](../notifier/README.md).

## Agent apps

| App | Shows | Needs |
|---|---|---|
| [Codex](src/busybar_apps/codex/README.md) | Codex task status | Codex Desktop or CLI. Optional hooks. |
| [Your dot](src/busybar_apps/dots/README.md) | Your dot task status | Local Orbit state or `busy-bar emit`. |
| [Claude Code](src/busybar_apps/claude/README.md) | Claude Code session status | Claude Code hooks. |

## Notifier apps

| App | Shows | Needs |
|---|---|---|
| [ADSBao](src/busybar_apps/adsbao/README.md) | An aircraft within three miles | Mac location. |
| [Datadog](src/busybar_apps/datadog/README.md) | On-call pages and alerting monitors | `pup`, signed in. |
| [GitHub](src/busybar_apps/github/README.md) | Review requests and pull request activity | `gh`, signed in. |
| [Jira](src/busybar_apps/jira/README.md) | Newly assigned tickets | A Jira client with JSON output. |
| [Metaflow](src/busybar_apps/metaflow/README.md) | Failed flow runs | A Python with the Metaflow client. |
| [Terminal](src/busybar_apps/terminal/README.md) | Finished commands | `busy-bar run -- COMMAND`. |
| [Credentials](src/busybar_apps/credentials/README.md) | Logins that need renewal | Check commands or timestamp files. |
| [Calendar](src/busybar_apps/calendar/README.md) | Meetings that start soon | `icalBuddy` and Calendar access. |

ADSBao uses its own setup command: `.venv/bin/busy-bar adsbao-location`.
The other notifier apps use the private `notifier.json` file.

## Add an app

- An agent app calls `busybar_agents.profiles.register` with an `AgentProfile`.
- A notifier app has a `sources(config, state_dir, **context)` function that returns `Source` objects.
  Add its name to `NOTIFIER_APPS` in `busybar_apps/__init__.py`.
- Keep account names, organization names, and internal commands in the private configuration.
- Add tests under `apps/tests` with recorded command output.

## Activity apps

[Gaming](src/busybar_apps/gaming/README.md) shows WoW, WoW Forever, and MapleStory while the game client is open. Each game has one owned Dispensable service. Agent and game renderers share the activity publication layer. Games do not use Agent hooks or token accounting.
