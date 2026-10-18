# Game Activity Implementation Plan

> Execute inline with executing-plans. The user explicitly authorized self-review and execution; do not wait for Claude or dispatch peers.

**Goal:** Show three game sessions and elapsed client-open time, publish through the existing queue, and state the actual browser login duration.

**Architecture:** A shared ActivityPublisher owns occurrence transitions, source freshness, withdrawal and pending native deltas for both Agent and games. A local AppKit helper returns bounded running-app metadata to a background sampler; a pure game tracker maintains the three known sessions. Games use the existing notification character entrance and cloud producer, with only the time region updated after admission.

**Tech Stack:** Python 3.10+, Pillow/native BUSY animation, Swift/AppKit, existing Cloudflare Worker/React/Tailwind/TanStack.

### 1. Shared activity publication
- [x] Add `shared/tests/test_activity.py`: real State fixtures verify stable item ID across updates, acked pending-delta merge, new identity retirement, dismissal tombstone and unknown freshness.
- [x] Run `.venv/bin/python -m unittest discover -s shared/tests -p test_activity.py` and observe the absent abstraction fail.
- [x] Add `shared/src/busybar_shared/activity.py`; use `begin(identity)`, `publish(content, changed)`, `renew()`, `unknown()` and `hide()`. Keep State's RLock across recognize and delta merge. Do not change Producer serialization.
- [x] Replace AgentRenderer's duplicated occurrence/delta writes in `service/src/busybar_service/cloud_adapter.py` with ActivityPublisher. Keep its motion, metadata and standby behavior unchanged.
- [x] Run activity and existing cloud adapter/routing tests.

### 2. Native detection and game lifetime
- [x] Add `apps/tests/test_gaming.py` with recorded synthetic snapshots: same-ID WoW path separation; launcher exclusion; exit/reopen; simultaneous games/clients; restart; PID reuse; unknown reads; boot, sleep and wall-clock changes.
- [x] Observe the missing tracker fail, then add `apps/src/busybar_apps/gaming/{__init__,sessions,display}.py` and `shared/src/busybar_shared/running_apps.py`.
- [x] Add `shared/src/busybar_shared/assets/RunningApps.swift` and `scripts/build-app-observer.py`. Read `NSWorkspace.shared.runningApplications`, exact client bundle paths, launch date, PID, boot UUID and mach continuous time. Bound JSON and timeouts; do not publish inventory.
- [x] Compile the helper and read actual application metadata without launching or quitting games. Compare with synthetic fixtures separately.

### 3. Game presentation and cloud integration
- [x] Add `service/tests/test_game_watch.py`: stable occurrence and scene animation during elapsed updates, time-only deltas, source expiry/withdrawal, restart recovery, three explicit owned routes.
- [x] Observe missing integration fail. Add `service/src/busybar_service/game_watch.py`, cached GAMING-to-title scenes and pixel controller icon, and integrate into `cloud_watch.py` without a second scheduler.
- [x] Register game sources explicitly via a `gaming-setup` command. Add optional priorityGroup creation input to existing registration; pass `dispensable` for games, preserve all existing registrations and credentials. Build the local helper before activating collection.
- [x] Test setup retry/idempotence and invalid group rejection. A fresh time update changes only the timer; admission uses a complete recovery scene.

### 4. Login copy and documentation
- [x] Add `control-plane/session-policy.ts` as the sole lifetime constant; use it in server security and sign-in text. Show “Stay signed in on this browser for 30 days.” Explain logout/site-data clearing and distinguish token lifetime.
- [x] Check the existing browser expiry tests and render the sign-in page in desktop/mobile Chrome.
- [x] Update English/Chinese root/app documentation in simple STE-style sentences with setup, timing meaning and ownership instructions. Add a labeled offline game animation preview.

### 5. Review, release and activate
- [ ] Run `.venv/bin/python scripts/run-tests.py`, `npm test`, `npm run typecheck`, `npm run dry-run`, native helper build, and diff checks. Self-review the actual final source and design acceptance list.
- [ ] Use personal-author commits, PR + all CI, normal main fast-forward, Cloudflare native Git build and exact published asset verification. Never force-push main or use GitHub squash.
- [ ] On this Mac only, create the three owned Dispensable registrations, reinstall cloud mode, verify source status and production snapshot. No credential replacement, other-Mac process changes, or protected-stash changes.
- [ ] Verify finite labeled synthetic frames on the real Bar only as a DEMO; distinguish actual app detection from animation demo. Withdraw synthetic activity and verify the real collector resumes.
- [ ] Explain phone device identity and independent browser pairing, then sync canonical project and Codex memory.

Self-review: every design requirement maps to a task; unknown reads do not end sessions, timer updates do not replay entrances, and shared Agent changes retain pending deltas. Production activation is the last step after local/CI verification.
