# Control Plane Motion Implementation Plan

> **For agentic workers:** Execute in order using executing-plans, with independent code review before release.

**Goal:** Add consistent, damped motion to the existing dashboard without restarting preview or altering server semantics.

**Architecture:** A page-scoped motion context gates animations by visibility and reduced-motion preference. Shared GSAP hooks animate stable list identities and semantic feedback. Number Flow owns numeric digit transitions; Base UI owns disclosure accessibility.

**Tech Stack:** React, GSAP/useGSAP, Number Flow, Base UI/shadcn, Tailwind, existing Vitest Worker tests.

### 1. Shared motion model and lifecycle

- [x] Add `control-plane/ui/motion-model.ts` with bounded entrance staggering and list displacement calculation. Test insertion, removal, rapid interruption, hidden/reduced-motion resets and unchanged structural identity in `control-plane/tests/ui-motion.test.ts`.
- [x] Add `control-plane/ui/motion.tsx` and `motion-scope.ts`: page-scoped visibility/preference context, MotionPage, scoped list reconciliation, mount reveal and semantic acknowledgement. Effects use `useGSAP` cleanup; measured offsets retain current visual position during interruption. Never retain deleted data or actionable DOM copies.
- [x] Run `npm test -- tests/ui-motion.test.ts` and `npm run typecheck` from `control-plane`.

### 2. Page, queue and service transitions

- [x] Replace only the four page-slot wrappers in `main.tsx` with MotionPage. Preserve preview key and sibling position.
- [x] Mark queue summary rows with stable group IDs; use list motion driven by group/order/expanded signature, not playback ticks. Use Base UI disclosure inside detail cells, with inert closed content and immediate deletion of ended rows.
- [x] Add first-visible group and configuration-summary entry. Keep all dnd-kit transforms on outer sortable elements; GSAP targets their inner surfaces. Disable entry during drag. Add confirmed service-capability and save acknowledgement; do not treat pending mutations as success.

### 3. Device metrics and accessibility

- [x] Gate shared SettingNumber animation by active visible page. Reuse it for revision, viewers, received/drawn FPS and latency, with actual precision and unavailable placeholders.
- [x] Animate Device status/controller only on semantic change. Leave IDs selectable and timestamp updates quiet.
- [x] Add Base UI height/opacity disclosure CSS, short state transitions and reduced-motion overrides. Preserve existing compact dimensions and shadcn overlay transitions.

### 4. Review and release

- [x] Run the full Worker/UI suite, typecheck and Vite build; inspect diffs for unrelated formatting and secret/session retention.
- [x] Request an independent review against the approved motion design; fix important findings and repeat affected checks.
- [x] Attempt desktop/mobile browser verification through the approved browser surface. Record any tool limitation explicitly; do not report visual checks as complete when unavailable.
- [ ] Commit, open and attach a PR, inspect CI, merge after green checks, and verify the native Cloudflare build and production assets. Synchronize stable main and canonical project knowledge.
