# Agent Checker and Notifier Implementation Plan

> For agentic workers: use executing-plans to implement these tasks in order.

**Goal:** Two reusable components, agent checker and notifier, with every toy
rebuilt as an app on one of them.

**Architecture:** `shared` utilities, `agent-checker` and `notifier` components,
`apps` on top, and one `service` coordinator. See the
[design](../specs/2026-10-15-agent-checker-notifier-design.md).

**Tech stack:** Python 3.10+, Pillow, busylib protobuf input, native BUSY
bicycle0 assets, macOS launchd and Keychain.

## 1. Move code without changing behavior

- [ ] Move the Codex package into `agent-checker`, `apps/codex`, and `service`.
- [ ] Move `adsbao-checker` into `apps/adsbao`.
- [ ] Update imports, patch targets, package discovery, and the test runner.
- [ ] Expect all 166 existing tests to pass. Commit.

## 2. Generalize the agent checker

- [ ] Add agent profiles and look up icons, titles, and hook mappings by source.
- [ ] Move rollout parsing to `apps/codex` and Orbit identity to `apps/dots`.
- [ ] Add the `claude` app: icon, hook mapping, and local turn identifiers.
- [ ] Add tests for profile lookup, Claude hook mapping, and turn reuse. Commit.

## 3. Build the notifier

- [ ] Extract the entrance renderer and presenter from ADSBao.
- [ ] Add the model, queue, poller, and seen-item store with tests.
- [ ] Rebuild ADSBao as a notifier app. Keep its existing tests passing. Commit.

## 4. Add notification apps

- [ ] Datadog pages and monitors, GitHub, Jira, Metaflow, terminal tasks,
  credential checks, and calendar meetings, each configured by `notifier.json`.
- [ ] Add `busy-bar run -- COMMAND` for terminal task alerts.
- [ ] Add source tests with recorded command output. Commit.

## 5. Connect the coordinator

- [ ] Replace the aircraft-only overlay with the notifier presenter and queue.
- [ ] Map Start/Pause to the primary action or dismissal.
- [ ] Update status output and watch-loop tests. Commit.

## 6. Verify and document

- [ ] Run the suite. Play every notification type on the device and capture it.
- [ ] Update the READMEs in short STE sentences. Open a pull request.
