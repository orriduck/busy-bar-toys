# Global priority groups implementation plan

> For agentic workers: use subagent-driven-development with isolated backend and UI ownership, then spec and quality reviews. User requested direct implementation/configuration; no additional approval step.

Goal: three actual global priority groups, own-computer drag management, and production groups configured as requested.
Architecture: shared group vocabulary; persisted service group + own serviceOrder; scheduler chooses global group, then a fair eligible computer, then its ordered service. Atomic complete own-group mutations; no new cross-computer authority. One-time missing-field migration configures existing services without credential rotation.
Tech stack: TypeScript Workers/SQLite Durable Objects, React/Base UI/shadcn/Tailwind/dnd-kit/GSAP/Number Flow, Vitest and isolated Chrome.

- [ ] Backend task: own src/* and backend tests. Add red scheduling tests for group preemption/resume, same-group source stickiness, computer FIFO completion fairness, background Hold, own service order and confirmed time. Add registration/schema/migration; groups request validation before any mutation. Preserve legacy order requests. Extend queue proofs and conservative ETA for queued urgent work. Run relevant tests/typecheck, report red-green and self-review.
- [ ] UI task: own ui/* and ui tests. Render three global droppable groups, computer provenance and compact read-only foreign rows. Pure model for own group reorder/cross-group moves. Snapshot revision fencing, accessible move menu, keyboard sorting, stable detail drafts, updated badges/runtime labels and grouped queue indicator. Verify unit tests and build.
- [ ] Integrate: reconcile API and UI compile/tests; update PROTOCOL.md and cloud-mode docs explaining groups and replace old issue35 tier-alignment guidance. Read-only spec review, then quality review; fix blockers and rerun relevant tests.
- [ ] Rendered checks: local mock, separate Chrome context, several owned and foreign fixtures. Pointer and keyboard group move, empty group, foreign immobility, policy persistence and long names; 320/390/768/1280 px with light/dark screenshots. Do not publish test pixels to real Bar.
- [ ] Release: PR attach, all Actions checks, merge/main sync, Cloudflare native deployment only. Verify actual API group mapping for all current registrations; unchanged IDs/epochs/config and active source integrity. Reply to issue35 and sync canonical memory. Do not touch paused producer/FPS stash or other Mac runtime.
