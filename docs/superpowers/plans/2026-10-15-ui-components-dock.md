# BUSY component foundation and preview dock implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to execute each implementation task, with specification review before quality review.

**Goal:** Match the supplied official reference, adopt reusable UI/state components and keep real display visible across the four pages.

**Architecture:** Keep React/Vite and the existing fenced SSE transport. Add Tailwind/shadcn source controls, device-scoped TanStack Query and a TanStack Table queue. Keep one Preview mounted while its CSS placement changes.

**Tech Stack:** React, Vite, TypeScript, Tailwind4, official shadcn/ui, TanStack Query/Table, Cloudflare Workers.

### Task 1: Foundation

Files: control-plane/package*.json, vite.config.ts, tsconfig.json, components.json; ui/components/ui/*, ui/lib/utils.ts, ui/style.css (imports/theme only).

- [x] Install Tailwind Vite integration, Query/Table. Configure @ alias to ui.
- [x] Initialize shadcn official source registry with base-nova. Fetch component documentation before use; add Button, Card, Dialog, Field, Input, NativeSelect, Switch, Checkbox, Table, Alert, Badge, Empty, Separator, Skeleton, Textarea.
- [x] Review generated components; apply BUSY semantic tokens and component variants. Primary buttons blue/pill; neutral secondary; controls 48 px desktop, inset highlights on surfaces. Avoid broad global button/input styling.
- [x] Run typecheck/build; commit only foundation files.

### Task 2: Composition and framework adoption

Files: ui/main.tsx, common.tsx, auth.tsx, pages.tsx, services.tsx, queue.tsx; new ui/snapshot-cache.ts; tests/ui-session.test.ts additions as needed.

- [x] Move controls/forms/dialog/table to installed shadcn source components. Preserve form revisions, stale-result guards and in-flight edits.
- [x] Model queue columns and expansion through useReactTable/getCoreRowModel; preserve grouping/App+Sender+Received semantics.
- [x] Use QueryClientProvider and useMutation. Snapshot cache key includes device ID and session generation. Clear cache on session reset; accept through SessionFence before setQueryData. Disable automatic mutation retries. Keep SSE and manual refresh; no credential persistence.
- [x] Add regression for cache isolation/revision ordering and verify existing session/queue tests. Run full npm test/typecheck/build. Commit owned files.

### Task 3: Reference shell and live dock

Files: ui/main.tsx, preview.tsx (presentation only), common.tsx, style.css; public official logo/device shell; asset attribution.

- [x] Copy observed public official assets, replace handmade Brand, and use calibrated logo/header/sidebar/card geometry from spec.
- [x] Hoist Preview out of hidden Display page, leave same instance/key active on all authenticated pages. Toggle host class between full and compact placements; no second stream and no Manage.
- [x] Fit true RGB canvas within official shell; implement mobile normal-flow preview and short-height sidebar scrolling. Update stale Display-only explanatory copy/docs.
- [x] Verify desktop/mobile browser layout, one stream across navigation, draft preservation and dialog keyboard behavior. Save screenshots. Full suite/typecheck/build, spec then quality review.

### Task 4: Release

- [x] Deploy formal Worker, inspect actual formal UI without changing device/service credentials.
- [ ] Open PR, attach, check latest-head CI, merge, fast-forward stable main. Retain actual preview and report frame-rate limitation accurately.
- [ ] Update canonical project memory and announce/run GitHub memory sync. Provide formal URL and screenshot proof.
