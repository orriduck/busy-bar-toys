# AI Status Light Implementation Plan

> **For agentic workers:** Use executing-plans for the connected implementation. Review source boundaries and final behavior independently.

**Goal:** Show real local task states on BUSY Bar using the ChatGPT logo or an original Your dot icon.

**Architecture:** A local Python observer reduces lifecycle events to metadata-only states. A Keychain-backed API client publishes expiring screen bitmaps. A LaunchAgent keeps the observer running; optional hooks enqueue permission/input and explicit dots events.

**Tech Stack:** Python 3.10+, unittest, Pillow, urllib, macOS Security/Keychain, launchd, BUSY HTTP API 27.5.0.

### Task 1: Lifecycle observation

- [x] Write tests in `tests/test_events.py` for start/complete/interrupt/wait, turn correlation, partial lines, ignored subagents, explicit dots classification and stale leases.
- [x] Run `python3 -m unittest discover -s tests -v`; confirm missing implementation fails.
- [x] Implement `src/busybar_status/events.py` with `TaskRegistry`, `RolloutWatcher` and hook normalization. Keep only task IDs, turn IDs, source, project basename and timestamps.
- [x] Run the same suite; require all state transitions to pass.

### Task 2: Display and transport

- [x] Add `tests/test_display.py` and `tests/test_api.py`; assert exact dimensions, ASCII-only transport labels, namespace cleanup, conflict handling and no secret in exceptions.
- [x] Implement `display.py`, `api.py`, `credentials.py` and the stdin-only `scripts/store-token.swift` helper.
- [x] Use the official ChatGPT icon as the source asset, design dots as an original SVG, and render compact screen PNGs. Provide a labeled local preview.
- [x] Run all tests and inspect previews at real pixel dimensions and an enlarged nearest-neighbor view.

### Task 3: Install, verify and publish

- [x] Implement `cli.py` with `watch`, `hook`, `emit`, `demo`, `preview`, `status`, `install`, `uninstall` and `clear` commands. Use an expiring metadata spool and select one shared display owner.
- [x] Install in `.venv`, store the authorized token in Keychain and check the device status without printing identifiers or credentials.
- [x] Test running/wait/done/dots displays with an explicitly labeled demo, then enable the LaunchAgent and verify this actual session appears as running.
- [x] Document source coverage, cloud-only dots limitation, startup, disabling and verification in `README.md`. Preserve existing hooks and never modify hook trust settings.
- [x] Run tests, scan the complete Git diff for secrets, commit, create private `orriduck/busy-bar`, push and confirm remote HEAD.
