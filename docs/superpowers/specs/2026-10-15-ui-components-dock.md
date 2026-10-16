# BUSY materials, component foundation, persistent preview

User-authorized follow-up to the four-page UI. Keep all current authentication, session/device fences, configuration revisions, real pixel preview and approved 150 ms bounded playout.

## Appearance

Use the official public BUSY logo (80 × 26 px), at left 24 px/top 35 px in a 96 px header. The desktop sidebar is 264 px, starts at (24,96), with a 40 px gap to the main surface. Main starts at (328,96), uses #181818, 24 px corners, 32 px content padding, and inset highlights (white 10% top 1px, white 4% outline). Background #0a0a0a, Inter. Navigation 48 px high, 16 px corners, 16/24 medium text. Blue primary pills, neutral gray secondary pills; red belongs to the BUSY logo. Use the official blank device shell with the same actual 72×16 RGB canvas. No fabricated battery/network readings.

## Components and state

Keep React/Vite. Install official shadcn/ui source components and Tailwind v4 via Vite. Use semantic CSS tokens and shared component variants; remove competing global control styles. Forms use FieldGroup/Field and inputs, native select, switch/checkbox. Accessible Dialog for one-time credentials; preserve close/copy behavior. TanStack Query owns device/session-scoped snapshot cache and mutations, with no persistent credential cache, automatic mutation retry or cross-session cache reuse. SSE remains the authoritative push source and existing SessionFence accepts revisions before cache writes. TanStack Table models the queue's App, Sender, Received columns and expansion.

## Persistent preview

Render exactly one Preview per authenticated device/session. On Display it appears above the queue; on Services, Configuration and Device the same mounted node becomes a fixed bottom-left card (left/bottom 24 px, width264). No Manage button. Keep real capture demand on all visible authenticated pages. Hidden document, pagehide, logout, device/session change and unmount stop demand and clear pixels/buffer. Never make two preview SSE connections to fill two views. Compact label/status must remain legible. Mobile preview occupies normal flow beneath navigation so it never covers form controls. At short desktop heights reserve sidebar scrolling space above the dock.

## Acceptance

Typecheck, full Worker/UI tests, production build, independent spec/quality review and CI. Verify formal URL desktop/mobile, exact logo bounds/material, all pages and actual preview visible in dock. Check one preview viewer across navigation, no Manage, dirty configuration draft survives navigation/SSE, modal keyboard dismissal, no demo banner in production. Report measured FPS honestly; 150 ms buffer does not increase source capture FPS.
