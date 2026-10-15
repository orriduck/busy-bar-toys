# ADSBao Checker Implementation Plan

> For agentic workers: use executing-plans to implement these tasks in order.

**Goal:** Show fresh aircraft within three statute miles, with a finite animation
and automatic restoration, alongside the existing Codex checker.

**Architecture:** Keep one launchd observer. Put Codex logic in `codex-checker`,
aircraft logic in `adsbao-checker`, and device/animation primitives in `shared`.
The observer pauses Codex drawing while an aircraft presentation owns its existing
namespace, then forces a fresh Codex entrance or releases the firmware calendar.
Both sources continue to update independently of the display transition.

**Tech stack:** Python 3.10+, Pillow, standard-library HTTP/SSE, Swift Core Location,
native BUSY bicycle0 assets, macOS launchd and Keychain.

## 1. Move code without changing behavior

- [ ] Move the existing package to `codex-checker/src/busybar_status`.
- [ ] Move device transport, frames, credentials, Wi-Fi and input modules to
  `shared/src/busybar_shared`. Update imports and repository-root paths.
- [ ] Extract `encode_sections`, fades, and generic pixel text to shared modules.
  Keep Codex digit atlases and task presentation in the Codex package.
- [ ] Split tests between the checker and shared directories. Add
  `scripts/run-tests.py` to discover all three suites. Update setuptools and CI.
- [ ] Run `.venv/bin/python -m pip install -e .` and
  `.venv/bin/python scripts/run-tests.py`. Expect all existing 121 tests to pass.
- [ ] Commit the verified move before adding behavior.

## 2. Detect nearby aircraft

Files: `adsbao-checker/src/adsbao_checker/{traffic,proximity,location}.py`,
`adsbao-checker/tests/test_{traffic,proximity,location}.py`.

- [ ] Add failing tests with fresh synthetic SSE envelopes. Check three-mile
  boundaries, invalid coordinates, stale frames/fixes, ground records, sequence
  ordering, same-plane suppression, 3.5-mile/60-second re-entry and persistence.
- [ ] Parse bounded SSE events and validate the actual ADSBao envelope contract.
  Run one stream worker with bounded reconnect delays and replace its channel
  when the location changes. Stop closes the stream.
- [ ] Use a validated location value and great-circle distance in metres.
  Store bounded encounter metadata in an atomic mode-0600 file.
- [ ] Add a macOS location helper application under `adsbao-checker/macos` and a
  reproducible build script. Write coordinates only to the private runtime file.
  Bound fix age/accuracy and report permission/error states explicitly.
- [ ] Test denied/missing/stale location without requesting real permission.
  Verify the helper compiles and its application metadata is complete.

## 3. Show and restore alerts

Files: `adsbao-checker/src/adsbao_checker/{display,presenter,checker}.py`,
`codex-checker/src/busybar_status/cli.py`, shared native transition primitives.

- [ ] Add presenter/coordinator tests for entry, ten visible seconds, exit,
  button dismissal, reduced motion, rejected draw, and Codex/calendar restoration.
- [ ] Render a compact pixel aircraft, callsign and distance. Build a finite
  native fly-in asset and reuse the shared fade masks. Label mock back views DEMO.
- [ ] Integrate one aircraft worker and presenter into the existing observer.
  Continue lifecycle/button polling; reset unseen standby holds and force a fresh
  Codex entrance after release. Keep source errors independent of Codex.
- [ ] Add `adsbao-status`, `adsbao-location`, `adsbao-demo` and `adsbao-preview`
  commands. Install the location helper through the normal install command.
  Provide an explicit fixed-coordinate setup command for development.
- [ ] Run the full suite and capture a live public sample stream separately.

## 4. Verify and deliver

- [ ] Create an offline rendered preview and inspect representative frames.
- [ ] Stop the real observer, run a finite mock on the real device, capture the
  entrance/hold/exit/restoration, then restore the real service in `finally`.
- [ ] Check actual service, cloud, input, and ADSBao/location diagnostics.
  Request a location authorization only through the native macOS permission UI.
- [ ] Document the new repository map, setup, deduplication, limitations and mock
  evidence. Preserve concise technical English in READMEs.
- [ ] Run all tests, `git diff --check`, and a credential leakage scan.
- [ ] Commit, push the same repository, verify CI and remote SHA, and synchronize
  memory without adding secrets or current location to version control.
