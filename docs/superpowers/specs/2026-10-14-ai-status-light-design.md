# BUSY Bar AI status light

User-approved direction: build option 1, with ChatGPT's icon for ordinary tasks and a separate original icon for Codex's Your dot. Create a GitHub repository. Approval: 2026-10-14 in the originating chat.

## Behavior

Front screen: a 16-pixel source icon, a short state label, elapsed minutes and a small state-colored progress accent. WORK blue, WAIT amber, DONE green, ERROR red; interrupted work says STOP in gray. Back screen: source, project folder name, state, elapsed time and concurrent task count. Never display prompts, replies or tool arguments.

Local Codex Desktop tasks are observed through incremental reads of local session event logs. Hooks provide structured waiting/permission and source events without blocking an AI turn. Multi-task selection puts waiting first, then running, then recent failures/completions. Completions expire after 12 seconds. Running leases expire to UNKNOWN after 30 minutes without events; no inferred completion. A timed-out element disappears on the device if the helper stops.

Dots source classification uses explicit origin metadata or configured dot thread IDs, never a title keyword. Cloud-only Your dot runs require an event bridge; absence of local execution events must be documented rather than represented as live integration.

## Device and transport

The verified device uses firmware 1.2.4, HTTP API 27.5.0. Send display elements under application_name `ai-status` using priority 50. This cannot override a BUSY/CUSTOM focus session (priority 90); HTTP 409 is a normal suppressed update. Clear only `ai-status` elements. Do not change timers, brightness, audio, Wi-Fi, account settings or other apps' assets. Chinese folder names are rendered locally to a bitmap. No sound by default.

## Credentials and installation

Use macOS Keychain, read via `/usr/bin/security`. Initial secret is supplied on stdin to a native Security-framework helper, never through argv or a file. Hooks write metadata-only events to a private local spool; the background helper owns network calls. Install a per-user LaunchAgent and provide status, uninstall, preview and demo commands. GitHub repository is private.

## Acceptance

Meaningful tests cover overlapping turns, stale turns, partial JSONL writes, source classification, multi-task arbitration, selective cleanup, priority conflict and credential redaction. Verify fresh device API responses and both rendered screens. A demo is identified as a demo. A real running state must come from this session's actual lifecycle event.

