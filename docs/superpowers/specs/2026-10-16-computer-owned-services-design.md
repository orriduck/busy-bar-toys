# Computer-owned services and stable configuration workspace

Status: implementation in progress. User clarified ordering and Notifier routing on 2026-10-16. No production changes yet.

## Intended result

1. A verified computer identity can manage only its own registered services. Device-token login alone grants monitoring access, not ownership of all computers.
2. Each notification application has its own registration and service ID. Datadog and GitHub are separate services. GitHub's review, comment, CI and commit collectors share its GitHub registration. Notifier is a local delivery engine, not a registered application.
3. Configuration opens one service at a time. Desktop keeps a stable, equal-width order pane and detail pane. Numerical service priority is removed; order is the single ordering control.
4. Update the local client, register fresh application services, install them, and verify real production delivery. Keep the original paused FPS work untouched.

## Current evidence

- `control-plane/src/store.ts` persists one `control` JSON header per device in a SQLite Durable Object; services and sessions are currently in that header. Items, assets, tombstones, actions, input receipts and commands have separate bounded row tables. `audit` stores bounded dispatch metadata. There is no separate computer ownership relation today.
- `Service.computerId` exists, but `DeviceControl.authorize()` accepts all valid browser device sessions for all management operations.
- `ui/computer-binding.ts` stores a freely selected localStorage label. This is explicitly presentation-only, not identity proof.
- `/services/order` rewrites every service's `config.priority`; the configuration form also exposes that number. Multiple configuration collapsibles can be open.
- The local cloud watcher creates only agent/notifier producers. Every notifier source uses the same producer and Keychain entry.
- This installation currently enables no `notifier.json` application sources and has an ADSBao configuration. Its installed services are an Agent and a mixed Notifier. Registration will create Codex and ADSBao; no Datadog/GitHub polling will be enabled without configuration.

## Ownership and authentication

Introduce an explicit Computer record scoped to one BUSY device:

- `id`: server-issued stable installation UUID.
- `credentialHash`: hash of a computer management secret; plaintext retained only in macOS Keychain.
- `serviceOrder`: an explicit ordered list of that computer's service IDs.
- `createdAt`, `revokedAt`: lifecycle metadata, no hardware fingerprint or precise location.

A Service has immutable `computerId`; template/app labels describe its purpose without restricting its message content. Ownership cannot be changed by a PATCH or by naming another computer during registration. A Session records its verified `computerId` on the server, separately from the signed device-login cookie. Browser preferences never authorize anything.

Device API token login remains valid for monitoring Display, Services, Configuration, Device and real preview. An unpaired browser sees a clear read-only state and a Pair this computer action. It cannot register services, alter order, change policy, toggle capabilities, rotate credentials or remove registrations.

The local CLI holds the computer credential and can issue a single-use browser pairing code. The authenticated browser redeems that code; the server consumes it atomically and binds the current session to that computer. Use at least 128 random bits, a five-minute lifetime, a bounded outstanding-code count, hashed storage, and no code in URLs/logs. Sign out clears that session binding. A new device login must pair again. A phone may manage a computer only after this explicit pairing; the browser cannot prove the physical hardware it runs on.

For a new installation, the logged-in management page creates a short-lived enrollment ticket for a new server-issued computer. The ticket includes its server-issued computer ID. The CLI generates a 256-bit management secret and saves the full credential in Keychain before redeeming the ticket; the server stores its hash and returns no secret. A lost response can be checked with the already saved credential. The ticket-creating session becomes bound only after successful redemption. Existing computers cannot be selected from a drop-down and impersonated.

For the initial legacy migration, the CLI proves possession of the active publisher credentials of all registrations belonging to its existing computer. The server validates every credential and that the supplied set is complete before accepting that computer's first locally generated management credential. The client persists it before submitting the claim. This route closes once enrollment exists. It cannot claim another computer using an ID alone, a single credential from a multi-service computer, or a revoked/expired credential. Existing computer IDs are retained; application service IDs are newly issued and use the computer credential for publication.

All ownership checks run in the Durable Object before tick or state mutation. Rejected requests leave configuration, playback and persistent state unchanged. A computer credential can manage and publish through any service owned by that computer. A legacy single-service publisher credential stays limited to its original service and cannot manage configuration. Device/Origin/CSRF and expected-revision checks remain.

## Application registrations and local delivery

Register one named service for each enabled application, such as Codex, GitHub, Datadog and ADSBao. Notifier remains a generic local delivery engine. It selects an explicit `serviceId` per message; the computer determines which content belongs to which registration. Do not enforce a server-side message-app enum or duplicate per-app publisher credentials. The computer credential is held by the local client, with server-enforced ownership of every target service. A missing/foreign service ID is rejected rather than assigned a fallback identity. Legacy single-service credentials cannot name another service.

Scene assets, heartbeats, receipts, actions and local urgent fallback stay scoped to the explicitly selected registration. Producer HTTP/SSE scope must include both the authenticated computer and target service, without leaking computer credentials to the browser.

The local watcher loads a bounded application registration manifest and creates one Producer/outbox per registered service. Source names/apps route through an explicit local source-to-service-ID map to the matching producer. Multiple GitHub sources route to GitHub; none route to a fallback generic publisher. A missing registration prevents that source from polling/sending and reports a bounded setup-required diagnostic. Preview and physical button bridges choose an explicitly enabled local service and continue working with the new producer map.

A computer credential is stored in its dedicated Keychain entry. Legacy role credentials remain available only for migration. The helper accepts only documented key names. Secrets never enter argv, repository files, screenshots or memory. Runtime metadata contains IDs, epochs and origin only.

## Single ordering model

Remove editable priority and its presets, slider and queue badges. Replace service priority with explicit order data. Urgent message precedence remains a separate message-level safety rule; it is not an editable service priority.

User confirmed that the order list must show all computers, while only this computer's services are sortable/configurable. Use grouped per-computer service order, with peers visible read-only. Across computers the scheduler rotates between ready computers at normal completion/source-end boundaries; an active source-controlled item retains its lifetime until the source ends, expires, or is interrupted by urgent work. This does not promise time slicing or bounded wait for an indefinitely active source. Within a computer, service order selects its next eligible normal service; messages within that service retain stable receipt order. Urgent messages keep the existing stable urgent order.

Migration converts the old descending priority order once, preserving deterministic ties. Registration appends to the owner's order. Removal drops its ID. Reject duplicate IDs, foreign IDs, missing owned services and stale revisions atomically. Do not keep a hidden numerical priority as a second scheduler authority.

## Configuration UX, reviewed with gpt-taste

Use the existing BUSY visual language and shadcn/Base UI components with Tailwind. This is an operational console, so the skill's marketing Hero, huge vertical sections and pinned scrolling patterns would conflict with the user's compact layout and are not applied.

Desktop at a sufficiently wide content breakpoint:

- One stable two-column workspace, `minmax(0,1fr) minmax(0,1fr)`. Left is the compact ordered list; right is the selected service editor. Opening or saving a service does not alter column widths or expand list rows.
- Each list row has a drag handle, small position value, app icon/name and a short owner marker. Selected state uses a restrained background and edge indicator. Foreign services are visibly read-only; they have no active drag handles or mutation menus.
- One `selectedServiceId`, not a Set of open cards. Service switching retains in-memory drafts by ID; only the selected form is interactive. Server changes do not silently overwrite a dirty draft. Deleted services clear selection safely and cannot be saved by a stale form.
- Detail pane shows app/name/owner, then compact Hold and Heartbeat fields with existing snap sliders, editable Number Flow badges and hover/focus help. No Priority, Exit or Later controls. Enable/disable, preview/input capabilities and credential operations remain in Services, with the same owner check.
- Save/Discard appear inside the detail pane when dirty, with existing confirmation feedback and revision-conflict handling. UI capability is derived from authenticated server session ownership, not localStorage.

Mobile and narrow content:

- A compact order list opens a single full-width detail view with a Back to order control. Avoid two small side-by-side columns or nested expanding cards.
- Keep the existing five equal-width floating navigation buttons, safe-area clearance and persistent real preview. Back preserves drafts and focus.
- Long app names, UUIDs, slider labels, dialogs and control tooltips must not expand document width at 320/390/760px.

Motion is subordinate to stability: retain scoped GSAP list movement and short selected-editor fade/settle; do not animate the draggable outer transform from two owners. Respect reduced motion, preserve keyboard drag and focus, and keep hidden forms inert/unmounted.

## Migration and release sequence

1. Add schema migration, complete Computer/Service ownership checks, enrollment/pairing and explicit service ID routing with HTTP runtime tests. Computer-authenticated publication requires an explicitly owned service ID.
2. Update Python registration storage, Keychain helper, CLI enrollment/pairing, per-app producer routing, preview/input selection and outbox handling.
3. Implement the stable single-selection UI and remove priority from forms, queue metadata and registration payloads.
4. Verify with two computers, distinct sessions and separate Datadog/GitHub publishers in an isolated local stack. Test actual rendered desktop/mobile geometry and drag/edit behavior.
5. Complete independent review and CI; merge and use native Cloudflare Builds. Verify production assets, authentication boundaries and schema migration.
6. Enroll this local computer using its existing private publisher credentials. Create fresh Codex and ADSBao registrations using the computer credential. Preserve unresolved fallback deadlines, action receipts, source encounter/seen ledgers and ended-message dedupe. Do not replay the old Notifier history into new service IDs.
7. Stop the old local observer only at the controlled handover; install the updated watcher, verify healthy scoped snapshots and real service IDs, preview/input and source delivery, then remove this computer's old Agent/Notifier registrations using owner authorization.
8. Existing single-service publishers on other computers remain scoped to their original service. Supply the upgrade/enrollment instructions needed to split their local notification routes; do not claim those clients were upgraded remotely. Their management requires verified computer ownership, even before they upgrade. Do not silently repurpose another computer's credentials or change its local files.

## Completion evidence

- Owner A can create/patch/toggle/rotate/remove/reorder A; A cannot perform any of those on B. An unpaired device session cannot mutate either. Forged computer ID/localStorage, stale pairing, reused code, incomplete legacy claim and direct HTTP bypass fail without mutation.
- Two notifier applications have distinct registration IDs, outboxes and action scope. The same computer credential can publish to either explicit owned ID, regardless of its app label; foreign/missing IDs are rejected. Disabling GitHub does not disable Datadog. Missing app registration never falls back to mixed delivery.
- Scheduler tests prove the chosen order semantics, urgent precedence, stable receipt order, order migration, active-source lifetime and no authority from obsolete priority values.
- UI interaction tests and real browser inspection prove one editor at a time, stable desktop pane dimensions, draft retention, owner read-only state, keyboard/pointer drag, revision conflicts and mobile no overflow.
- Full Python/Worker/UI suites, typecheck/build, independent review, GitHub CI and native Cloudflare release pass. Production serves the tested build.
- This Mac's new service registrations and installed service actually run against production; old owned registrations are removed only after verified handover. Record any other Mac migration still required explicitly; never equate mock delivery with live runtime success.
