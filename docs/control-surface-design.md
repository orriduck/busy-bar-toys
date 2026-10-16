# Queue and service control surfaces

This refinement retains the BUSY palette, typography, shadcn Base UI components,
Tailwind, TanStack Query, Number Flow and the existing GSAP motion environment.
It borrows containment and state feedback from [Material 3 Expressive](https://design.google/library/expressive-material-design-google-research),
without replacing the application's visual identity.

## Playback queue

- A confirmed player leads the list. Other entries retain server order. A thin
  progress line and an equalizer identify playback; the browser never starts
  the next player because a local countdown reaches zero.
- Eligible Dispensable services share a small rotation strip. Its icons represent
  distinct services, because Hold belongs to a service rather than each message.
  The active treatment follows the confirmed owner. Higher-priority arrivals can
  interrupt this pool without changing its priority or Hold rules.
- Keyed entries move into place through the existing scoped GSAP list motion.
  Withdrawn entries become inert, noninteractive visual departures for at most
  240 ms. At most twelve departures survive a mass update. Reappearance cancels
  departure; hidden pages and reduced-motion preferences remove immediately.
- Details retain grouped messages and their actions. Sender and receive time use
  bounded metadata tiles. Full provenance is available on demand. Actions remain
  computer-scoped; a primary device action also needs current playback proof.

## Configuration

- The global three-group list remains editable only for the paired computer.
  Keyboard drag, pointer drag and the equivalent group menu keep their existing
  server revision and ownership fences.
- On desktop the list and editor are separate surfaces. The list scrolls when
  needed; the editor keeps its own natural height instead of stretching into an
  empty column. Phones retain the list/detail navigation and focus return.
- Publisher liveness and actual display state occupy two metadata tiles. Hold
  and Heartbeat occupy two control tiles. The latter retain snap detents,
  editable Number Flow values, help, save/discard and draft retention.
- Full service/computer identities, capabilities and long current titles remain
  available in Connection details. Long values wrap; descriptive previews have
  bounded lines and an accessible full value. Exit and Later are not reintroduced.

## Services

- A short, collapsible setup guide explains pairing, adding a service and sending
  its first update. The current computer comes first. Other computers stay visible
  and read-only, with their permission shown once at the group boundary.
- Service cards foreground the name, connection, actual activity and enable switch.
  Connection details contain the less frequently used Bar-button and preview
  switches, last heartbeat and full service ID. Existing credential replacement
  and revoke confirmation remain available.
- Adding a service starts with Agent status, Notifications or Your own app, using
  shadcn Toggle Group. A unique ID is supplied automatically; a custom ID is an
  advanced option. Registration still requires explicit submission.
- After creation, a sender guide produces `busy-bar cloud-route SOURCE SERVICE_ID`.
  Identifier validation matches `cloud_registration.valid_id`, including reserved
  names. A leading hyphen uses the CLI's `--` separator. No shell syntax, embedded
  newlines or unsupported source names are rendered as executable instructions.
  The page does not run commands or claim the sender is connected before evidence.

## Acceptance

Run `npm test`, `npm run typecheck`, `npm run build` and `npm run dry-run` in
`control-plane`. Presentation tests cover confirmed ownership expiry, server
order, distinct-service rotation, grouped/orphaned items, bounded departure,
reappearance and local route validation.

Browser validation uses installed Chrome and explicitly labeled local mock data,
not production publisher credentials or Bar writes. Exercise:

1. Two background services alternate by Hold; a higher-group arrival inserts and
   becomes confirmed, then withdrawal restores a background player.
2. Inspect real animation frames: a removed row fades/collapses, is inert, has no
   controls, and is removed after the exit window. Reduced motion skips retention.
3. Save/discard policies, switch pages with unsaved edits, change groups by menu,
   keyboard and pointer, and verify peer controls remain disabled.
4. Add a service, choose a template, use its generated ID and enter a local source.
   Verify the route guide and invalid-input feedback without executing the command.
5. At 320, 390, 768, 1024 and 1440 pixels, inspect long names, expanded identities,
   queue details and add-service controls. Check document and surface scroll widths,
   light/dark themes, focus, mobile back navigation and framework/runtime errors.

These checks prove UI behavior with simulated state. They do not assert live
preview availability, physical Bar animation quality or a device frame rate.
