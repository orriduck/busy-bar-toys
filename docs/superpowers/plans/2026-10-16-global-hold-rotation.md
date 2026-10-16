# Global Hold rotation implementation plan

Goal: prevent source-controlled agents from monopolizing equal/lower-tier display work while preserving ownership and notification identity.

Architecture: global tiers from explicit order; persisted service turn budgets/FIFO tickets; native-confirmed visible-time accounting; matching queue/progress/alarms; concise service details.

- [x] Write failing scheduler tests for global preemption, Hold alternation, interrupted turns, confirmations and finite lifetimes.
- [x] Replace same-computer source pinning with global tier/turn selection; migrate old state safely and bound/remove stale turn records.
- [x] Integrate alarm deadlines and snapshot playback/ETA with service turns; cover runtime and SQLite restart behavior.
- [x] Add validated last-heartbeat metadata and compact service details; update Hold explanations and documentation.
- [x] Run focused/full tests, typecheck/build and independent review: 359 Python + 301 Worker/UI pass. Browser validation blocked as noted below; no visual claim.
- [ ] Merge, verify all CI/native Cloudflare Builds and live API convergence, retain existing local registrations, sync canonical memory.

- [x] Split all active agent input requests into an independently registered notifier; enforce routing identity and preserve Start/Pause dismissal.
- [x] Add authenticated withdrawal, tombstone fencing and durable local retries.

Browser verification is currently blocked by the executor root /Users/ruyyi/Devs/busy-bar being a symlink; CUA cannot start. Do not change the alias or weaken sandbox settings. Production assets/API and CI can still be verified.
