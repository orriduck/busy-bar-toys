# Global Hold rotation implementation plan

Goal: prevent source-controlled agents from monopolizing equal/lower-tier display work while preserving ownership and notification identity.

Architecture: global tiers from explicit order; persisted service turn budgets/FIFO tickets; native-confirmed visible-time accounting; matching queue/progress/alarms; concise service details.

- [ ] Write failing scheduler tests for global preemption, Hold alternation, interrupted turns, confirmations and finite lifetimes.
- [ ] Replace same-computer source pinning with global tier/turn selection; migrate old state safely and bound/remove stale turn records.
- [ ] Integrate alarm deadlines and snapshot playback/ETA with service turns; cover runtime and SQLite restart behavior.
- [ ] Add validated last-heartbeat metadata and compact service details; update Hold explanations and documentation.
- [ ] Run focused/full tests, typecheck/build, browser mobile/desktop validation and independent review.
- [ ] Merge, verify all CI/native Cloudflare Builds and live API convergence, retain existing local registrations, sync canonical memory.
