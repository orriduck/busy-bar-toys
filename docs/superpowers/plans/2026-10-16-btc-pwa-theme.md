# BTC PWA and Theme Implementation Plan

> Execute inline with executing-plans; independent code review before merge.

**Goal:** Fix mobile scroll overlap, add Auto/Light/Dark, installable BTC and a safe hostname migration.

**Architecture:** Semantic CSS themes and a small preference controller; one existing navigation DOM; generated app-shell-only service worker; rename the existing backend and keep a stateless old-host collector bridge.

**Tech Stack:** Existing React / Base UI / Tailwind / Vite / Vitest / Cloudflare Workers Builds.

- [x] Reproduce screenshot layer cause at localhost:8789; inspect header and preview computed z-index before/after scroll. Fix in style.css/mobile.css and retain preview key.
- [x] Add tests/ui-theme.test.ts for default/invalid preferences, Auto → Light → Dark cycle and system resolution. Implement ui/theme.ts, theme-control.tsx and public/theme-init.js, with semantic theme.css. Wire one shared preference into desktop/mobile buttons.
- [x] Add PWA build plugin and tests for exact shell allowlist, API/mutation/cross-origin rejection and network-first navigation. Generate versioned sw.js and manifest; add standard icons and install instructions. Test actual registration and offline shell without caching API data.
- [x] Inspect existing Cloudflare rename draft; update wrangler config and test legacy bridge. Keep original namespace ID; record before/after namespace and service continuity. Update docs/default collector setup URL, preserve existing configured URLs via bridge.
- [ ] Run full tests/typecheck/build, responsive browser checks, independent review; commit/attach PR, await CI and merge.
- [ ] Apply reviewed rename/config/build changes at release, verify native build, new host and old API/WebSocket paths. Verify no unexpected database/registration changes; sync main and canonical memory. Record actual iOS installation limitations.
