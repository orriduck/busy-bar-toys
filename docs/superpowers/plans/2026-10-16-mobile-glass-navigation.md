# Mobile Navigation Implementation Plan

> **For agentic workers:** Execute in order using executing-plans, with an independent review before release.

**Goal:** Deliver the user-specified floating icon-only mobile menu and remove identified mobile width pressure.

**Architecture:** Adapt the existing navigation DOM with responsive CSS and a decorative selected backing. Add safe-area-aware document space. Fix content intrinsic sizing and numeric formatting at their source; retain existing component behavior and preview lifecycle.

**Tech Stack:** React, shadcn/Base UI, Tailwind/CSS, existing Number Flow and GSAP motion, Vitest Worker tests.

### 1. Formatting and semantics
- [x] Add `ui/number-format.ts` with separate maximum and minimum decimals; test integer settings, fractional settings, FPS and integer metric behavior in `tests/ui-number-format.test.ts`.
- [x] Wire SettingNumber to maximum decimals by default and opt Device FPS into one minimum decimal.
- [x] Extract `ui/navigation.tsx` and add explicit navigation accessible names, a decorative selection backing and responsive label class. Add a navigation server-render accessibility regression if the current runtime supports it.

### 2. Mobile layout
- [x] Update `main.tsx` navigation presence attribute and `ui/index.html` viewport-fit.
- [x] In `mobile.css`, implement the compact glass capsule, selection transition, safe insets, reserved scroll space and contrast/transparency fallbacks. Apply to narrow screens and coarse-pointer phone landscape, preserving desktop layout.
- [x] In `pages.tsx` and `configuration.tsx`, mark computer actions and group summary badges; reflow on mobile. Fix long text, card/field minimum sizing, queue wrapping, slider endpoint labels, touch targets and dialog viewport bounds.

### 3. Verify and release
- [x] Run focused tests, full UI/Worker suite, typecheck, build and diff checks. Review mobile/desktop cascade and known browser-validation limitation.
- [x] Obtain independent review; fix important findings and rerun affected checks.
- [ ] Commit, create/attach PR, check CI, merge and verify native Cloudflare deployment plus live asset hashes. Remove temporary dependency link, confirm clean main and synchronize canonical knowledge.
