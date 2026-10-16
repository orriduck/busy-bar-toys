# Control plane motion audit and design

Status: approved by the user on 2026-10-15. Baseline: main `9cc4668`.

## Direction

Extend the existing compact BUSY dashboard with restrained, damped motion: a fast start and a slow, precise finish, without overshoot. Preserve the approved layout, typography, material, three-slider configuration and persistent live preview. Motion communicates arrival, position, ownership and confirmed state changes.

Three approaches were considered:

1. Recommended: shared motion primitives plus semantic change detection. Provides consistent page, list and metric transitions without coupling effects to streaming updates.
2. Entrance effects alone: cheaper, but leaves queue changes, ownership and metadata updates abrupt.
3. Cinematic scroll and continuous card effects: visually prominent, but conflicts with this compact operational dashboard and makes frequent updates distracting.

The requested gpt-taste skill's motion hierarchy, contrast checks and restrained component composition apply. Its marketing-page hero, large spacing, font replacement and scroll pinning do not fit the user's established dashboard requirements. Do not introduce those unrelated changes.

## Current audit

| Area | Current implementation | Proposed treatment |
| --- | --- | --- |
| Page navigation | Four page slots remain mounted and use `hidden` | Reveal only the activated page; preserve mounted state and drafts |
| Queue | Keyed TanStack rows; direct insert, removal and current-row change | Short entry, position settling, detail disclosure and confirmed ownership accent |
| Services | Computer groups and service rows appear directly | First-visible stagger; subsequent additions enter individually; confirmed status changes receive a brief accent |
| Configuration | dnd-kit owns outer transforms; mounted Collapsible editors | Animate inner surfaces and disclosure; retain dnd-kit ownership and keyboard behavior |
| Save actions | Conditional action bar with explicit focus restoration | Compact reveal; success acknowledgement after server confirmation; immediate errors |
| Device | Metadata mostly changes as plain text | Number Flow for numeric metrics; subtle semantic status/controller change; static selectable IDs |
| Settings | Existing Number Flow and GSAP slider effects | Reuse the same timing language; retain preset snapping and input semantics |
| Dialogs, menus, switches | Existing shadcn/Base UI transitions | Keep native component transitions; do not stack competing GSAP transforms |
| Live preview | Persistent canvas and SSE/viewer session | Preserve stream and canvas identity; never animate frame pixels or reconnect on navigation |

## Motion specification

### Shared timing and lifecycle

- Primary ease: `power3.out`; small acknowledgements use `power2.out`.
- First page visit: opacity and 8 px vertical arrival over 280 ms. Stagger child groups by 30 ms, with total entrance capped at 420 ms.
- Return visit: a 140 ms content fade without repeating the full stagger.
- List item arrival: 200 ms opacity and 5 px movement. Reposition: 240 ms settling. Removal must immediately remove actionable content; any decorative exit is inert and lasts at most 120 ms.
- Status change: a 160 ms crossfade or brief surface accent; no bounce, scale pulse or permanent animation.
- Use scoped `useGSAP`, refs, cleanup and context-safe delayed callbacks. Cancel/revert work when a page becomes hidden, a device/session changes, or its component unmounts. Preserve final visible styles on interruption.
- Reduced motion: no movement, scale, stagger or digit rolling. Render the actual state immediately. Decorative repeats pause offscreen or when the document is hidden.
- Content is visible by default; animation setup failure cannot leave it hidden.

### Display and queue

Animate stable group identities and confirmed ownership transitions. Changes to a row's textual payload, the 100 ms playback tick, frame statistics or an SSE heartbeat must not restart entrance or layout motion.

Use a bounded list-motion boundary. Reconcile current DOM positions before animating new positions; interrupt rapid updates from their current visual position. Do not alter table column widths, scroll position or row semantics. Details open and close with compact disclosure motion. Preserve focus; end/pause/run actions always refer to the latest live data.

The Playing badge and existing progress line remain truthful to confirmed playback. A subtle accent transfers to the confirmed controller. Do not animate selection as if it were confirmation.

### Services and configuration

Reveal computer groups and configuration summaries only on first visibility. Later registrations enter individually. Confirmed On/Off/capability changes can briefly accent their status; pending requests do not visually imply success.

Configuration entry targets an inner wrapper, never the outer element whose transform belongs to dnd-kit. Dragging interrupts entrance motion. Keep native pointer, touch and keyboard sorting. Collapsible animation preserves mounted drafts, focus and accessibility. Save/Discard appears without layout jumps; error feedback is immediate and never delayed for an effect. Secrets must not survive in animated exit copies.

### Device metadata

Reuse Number Flow for configuration revision, viewers, accepted frame rate, received/drawn frame rates and latency. Preserve units, decimal precision and unavailable `—` states. Do not fabricate zero before a real value arrives. Limit animations to the active page and meaningful value changes; do not announce every frame sample through a live region.

Connection, device health and current controller use restrained text/surface transitions when their semantic value changes. IDs remain selectable and static. Timestamps update normally without flashing their whole row. Relative or absolute time must retain its actual meaning.

## Boundaries and verification

No backend API, queue policy, publisher scheduling, FPS target, credential, device registration or production token changes are required.

Verify semantic change detection, bounded stagger and reduced-motion behavior with focused tests. Run the existing UI/Worker suite, TypeScript checks and production build. Exercise rapid navigation, SSE updates during entry, queue insert/remove/reorder, interrupted disclosure, drag start, dirty drafts, focus restoration, logout and unavailable metrics. Check desktop and mobile visually when the browser automation surface is available; a build passing is not visual verification.

Release through the existing native Cloudflare Workers Builds integration after review and green checks. Confirm the deployed assets and CI result; report any browser verification limitation explicitly.

## Implementation verification

On 2026-10-15, all 223 UI/Worker tests, TypeScript checks and Vite production build passed. The added actual-GSAP regression first reproduced a context-revert callback overwriting the saved offset; an isolated child context with `suppressEvents: true` fixes it and is independently reviewed. Two independent review passes found no remaining important issues.

Desktop/mobile visual acceptance remains pending: the computer-use kernel could not start in this workspace. No screenshot or animation-observation claim is made. Production build verification is tracked separately from visual acceptance.
