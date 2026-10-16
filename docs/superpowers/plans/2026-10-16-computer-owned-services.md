# Computer-owned services implementation plan

> Execute inline with test-first checkpoints. Keep this goal active until production and the local registration handover are verified.

**Goal:** enforce computer ownership, publish each notification app through its own service, and make Configuration a stable single-editor workspace.

**Architecture:** explicit computer management credentials and server-side session binding; computer-owned application service registrations; one producer/outbox per app; one ordering authority and one visible editor.

**Tech stack:** Workers SQLite Durable Objects, TypeScript, React, shadcn/Base UI, Tailwind, dnd-kit, scoped GSAP, Python, macOS Keychain.

## 1. Computer identity foundation

- [x] Add meaningful failing model tests for enrollment expiry/one-time redemption, live session binding, exact legacy credential-set claim, and cross-computer ownership.
- [x] Add bounded computer/enrollment/pairing state to `src/model.ts` and defaults in `src/store.ts`; never expose hashes in snapshots.
- [x] Implement these operations in a separate ownership module. Reject before mutation. Run the focused tests and typecheck.

## 2. Runtime authorization and enrollment

- [x] Add computer bearer parsing and authenticate it against the persisted computer credential hash.
- [x] Add bounded enrollment, legacy claim and browser pairing endpoints. Device-key login alone remains read-only.
- [x] Enforce ownership on registration, config PATCH, switches, credential rotation, removal and ordering. Reject spoofed computer IDs and publisher management.
- [x] Add HTTP/SQLite tests with two computers and independent sessions, including direct API bypass and no-mutation failures.

## 3. App registration and producer routing

- [x] Require an explicit owned service ID for computer-authenticated publication; retain single-service scope for legacy credentials. Message app labels remain controlled by the local computer.
- [x] Extend CLI/Keychain and registration metadata to one computer credential plus validated service IDs.
- [x] Build source-app routing to distinct Producer instances and durable outboxes; no generic fallback.
- [x] Cover two GitHub sources sharing one GitHub producer, independent Datadog, missing registration, actions/receipts and urgent fallback isolation.
- [x] Update preview/input selection to work with arbitrary registered local services.

## 4. Ordering and configuration workspace

- [x] User confirmed all computers visible, only own computer sortable/configurable; Notifier may publish to any owned registered service ID.
- [x] Convert legacy priority order once to the selected explicit order model; remove numeric service priority as an authority.
- [x] Replace multi-open collapsibles with a stable desktop list/detail layout and mobile list/detail navigation.
- [x] Preserve keyed drafts, revision conflict handling, focus, drag keyboard support and reduced motion. Read-only peers cannot mutate.
- [x] Remove priority controls/badges and obsolete registration payloads; retain compact Hold/Heartbeat controls and help.
- [x] Verify 320/390/760px plus desktop geometry in the real browser; do not infer visual success from a build.

## 5. Release and local handover

- [x] Full Python and Worker/UI tests, typecheck/build, independent security/UI review.
- [ ] Merge via reviewed PR, check all GitHub CI and native Cloudflare Builds, verify production assets and real authorization.
- [ ] Enroll this computer with existing private credentials, register fresh Codex/ADSBao services, and store new credentials only in Keychain.
- [ ] Preserve source encounter/seen/action/end receipts and fallback deadlines; prevent old mixed outbox replay.
- [ ] Controlled local observer restart; verify production scopes, actual preview/input, healthy publishing and corresponding service IDs.
- [ ] Remove only this computer's retired registrations after handover. Document the other Mac's required migration without claiming it was remotely upgraded.
- [ ] Sync the canonical project memory, record release/verification evidence, and audit all three user requirements before completing the goal.

## Checkpoint evidence

354 Python tests and 287 Worker/UI tests passed. Typecheck, production UI build and Wrangler dry-run passed. Independent review verified ownership, migration of existing leases, overlay queue ETA, event handover and urgent fallback. Chrome acceptance covered unpaired read-only view, actual browser pairing, peer-read-only controls, keyed draft retention, saving and keyboard drag ordering. Desktop panes were equal width with one visible editor; 320/390/760px views had no document overflow. A peer badge caused internal mobile heading overflow; its grid placement was corrected. Release and local production handover are still pending; do not claim them from these local checks.
