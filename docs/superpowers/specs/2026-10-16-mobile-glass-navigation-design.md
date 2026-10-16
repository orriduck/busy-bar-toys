# Mobile glass navigation and overflow

Status: user-directed design. The user specified an icon-only bottom menu, floating above the interface with an iOS-style material, plus mobile Services/Configuration and overflow improvements. Baseline: main `9db22aa`.

## Reference and scope

Checked Apple's current official HIG on 2026-10-16:
- https://developer.apple.com/design/human-interface-guidelines/materials
- https://developer.apple.com/design/human-interface-guidelines/tab-bars

Apple separates the Liquid Glass navigation layer from the content layer. This web implementation uses translucent blur, edge highlights and a selected backing shape as an approximation, rather than claiming to implement Apple's native renderer or complete iOS conformance. HIG normally recommends labels; the user explicitly requests no visible labels, so retain accessible names and desktop labels while showing mobile icons only.

Use one persistent navigation DOM, not separate desktop/mobile copies. At phone widths and coarse-pointer phone landscape sizes, position its four destinations in a bottom capsule with at least 44 px targets, safe-area spacing and a restrained moving selection backing. Keep the existing desktop sidebar. Respect reduced motion, high contrast and reduced transparency; support an opaque fallback without backdrop-filter.

## Layout and overflow fixes

- Reserve document space and scroll padding for the fixed menu so the final settings, actions and sign-out can scroll clear of it. Enable viewport safe areas without restricting zoom. Keep the menu below dialogs and menus in stacking order.
- Keep preview identity and streaming lifecycle unchanged. On mobile it remains in content flow.
- Reflow computer headers into identity, optional badge and action areas. Wrap long identity/name strings and keep actions reachable.
- Reflow configuration summaries into name/identity and badge layers; keep drag, rank and disclosure targets usable. Preserve dnd-kit transform ownership, mounted drafts and existing source-owned lifecycle semantics.
- Fix the numeric formatting regression: settings use a maximum of six decimals, not six mandatory decimals. Frame-rate metrics explicitly retain one decimal. This removes unnecessary width while retaining precision.
- Keep fields, input groups, cards, queue cells, and device metadata within their container. End labels align inward at both ends of the slider. Inputs use 16 CSS px on mobile to avoid focus zoom.
- Constrain dialog height to the dynamic viewport and safe areas, with internal vertical scrolling and wrapping for long credentials/IDs. Preserve focus management and credential cleanup.
- Do not use a global horizontal overflow clip to conceal a sizing defect.

## Verification

Add focused numeric-format regression tests and accessible-navigation server-render checks where supported by the existing test runtime. Run UI/Worker tests, TypeScript and production build. Independently review breakpoints, CSS specificity, stacking, safe-area reservation, long values, draft/focus retention and default desktop layout.

Target widths: 320, 375, 390, 430, 760 px; coarse-pointer landscape around 844 px; desktop 1280 px. Check long service names/IDs, all sliders, open configuration, registration, credential dialogs, sign-out, keyboard focus, reduced motion and no-blur fallback. The current computer-use kernel cannot start because a configured writable root contains the legacy busy-bar symlink; actual browser geometry and screenshots remain unverified unless that tool becomes available. Do not turn source inspection into a claim that a measured overflow test passed.

Verification completed: 22 test files / 231 tests pass, TypeScript and production build pass, and independent code review found no blocking issues. The formatting regression was reproduced with failing tests before the fix. Four actual navigation render cases verify accessible names and the selected destination. Browser viewport, screenshots and visual acceptance remain pending for the tool limitation above.

Release through the existing native Cloudflare Workers Builds integration after CI and review, then verify production assets and synchronize main and canonical project knowledge.
