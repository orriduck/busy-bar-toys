# Agent checker and notifier design

## Goal

Replace the two fixed toys with two reusable components and a set of apps.
The agent checker shows the status of local AI agents. Codex, Claude Code, and
Your dot are apps on this component. The notifier shows short alerts with the
ADSBao entrance motion. ADSBao, Datadog, GitHub, Jira, Metaflow, terminal tasks,
credential checks, and calendar meetings are apps on this component. The user
selected this structure on 2026-10-15.

## Layers

| Directory | Package | Contents |
|---|---|---|
| `shared/` | `busybar_shared` | Device API, credentials, button input, Wi-Fi setup, frames, fonts and pixel text, native encoding, fades, and character rolls. |
| `agent-checker/` | `busybar_agents` | Task registry, event spool, hook mapping, agent profiles, status light, clock and network layout, motion director, calendar latch. |
| `notifier/` | `busybar_notifier` | Notification model, priority queue, background poller, seen-item store, entrance renderer, presenter. |
| `apps/` | `busybar_apps.*` | One subpackage for each agent or notification source. |
| `service/` | `busybar_service` | Command line, launchd service, and the coordinator that owns the display. |

Components do not import apps. Apps register an agent profile or return
notification sources. The service imports the apps and connects them.

## Agent checker

Keep the current Codex display, light colors, standby timer, calendar latch, and
transitions. Move Codex rollout parsing and Orbit identity reading into the
`codex` and `dots` apps. An agent profile has a source identifier, a back-display
title, and a white source icon.

The spool accepts every registered source. `busy-bar hook --source NAME` maps
hook payloads with the profile's mapping. Claude Code uses these events:

| Hook | State |
|---|---|
| UserPromptSubmit, PreToolUse, PostToolUse | working |
| Notification | waiting |
| Stop | done |
| SessionEnd | stopped |

Claude Code hook payloads have no turn identifier. A `UserPromptSubmit` starts a
new local turn. Later events reuse the turn of the session's last spool record.
This keeps the rule that only a new turn restores a dismissed display.

## Notifier

A notification has an identifier, a level, an app, a brand, a title, a detail
line, an accent color, an icon, an optional group, and an optional primary action.

| Level | Detail and LED color | Event hold |
|---|---|---|
| urgent | Red | Until the condition clears or the primary action runs. |
| attention | Amber | Ten seconds. |
| info | The app accent | Ten seconds. |

The icon background always uses the app color. The user selected this on 2026-10-15.

The queue shows urgent items first, then new events, then standing conditions.
A standing condition hides after ten visible seconds and returns after 30
minutes if it is still true. The user selected the ten-second default on
2026-10-15; the private `display` section can change it. Items in one group show once, at the highest level.
A failed condition check replaces stale items with an `ERROR` item.

The entrance generalizes the ADSBao motion. The icon flies in, the brand holds,
and the characters roll to the title. The device then shows the title and the
detail as native text and scrolls text that does not fit. The ADSBao app keeps
its aircraft icon, jade accent, ten-second hold, and once-per-encounter rule.

Sources run in background threads. A command-line source must not block display
updates. A seen-item store under the private runtime directory prevents repeated
alerts after a restart. The first poll records a baseline and does not alert.

## Configuration and privacy

This repository is public. Do not commit team names, organization names,
internal commands, or internal account names. The notifier reads
`notifier.json` from the private runtime directory. Each source is off until the
file enables it. The file holds team names, ignored bot accounts, watched flows,
and credential check commands.

## Buttons and restoration

Start/Pause runs the primary action of a visible urgent item, for example a
Datadog page acknowledgement. On any other item, it dismisses all non-urgent
notifications and restores the calendar, as the current toys do. When the queue
is empty, the coordinator restores the agent view or the device calendar.

## Out of scope

Device-side button logic waits for a released firmware with JavaScript input
events. Firmware 1.2.4 does not include them.
