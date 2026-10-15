# Control plane UI specification

Functional scope is approved v5. The generated concept in `.local/control-plane-concept.png` defines the visual direction, not API truth or a raster UI asset.

## Layout and tokens

- Light neutral canvas `#f7f8fa`, white surfaces, charcoal `#141820`, muted `#657080`, hairline `#dfe3e8`; accent vermilion `#e44827`, urgent red, healthy green, snoozed amber. No decorative gradients or shadows.
- System sans UI, monospace times and priorities. 32px main heading, 20px section heading, 14px rows and controls, 12px labels. Minimum 40px interaction targets, visible keyboard focus.
- Slim header with dot-matrix brand and device identity, connection status and sign out. Desktop main area ~2:1 queue/settings rail, 28px gap. At <=900px stack queue above service settings; table horizontal overflow must remain usable, never clip buttons.
- Current confirmed owner is an emphasized horizontal region with narrow level-colored stripe, title, service/source, exit rule, and advertised action. Selected/applying/blocked is distinct from confirmed displaying. No sampled hardware preview in MVP.
- Queue is a table/list, grouped rows expandable into all members. Order, level, title/detail, service/instance, first seen, state and ETA remain accessible. Paused/snoozed rows have no active order. Pause/resume/end act on item identity and current revision.
- Services rail has registration and rows with enabled toggle, priority, exit mode, visible seconds, snooze minutes, heartbeat timeout, save and revoke. Credentials are visible only when created, with a copy control and local setup instructions.
- Empty state shows native calendar fallback. Offline and stale SSE remain visible, user writes do not silently retry revision conflicts. Errors have actionable plain text; do not display raw upstream responses.

## Sign-in and states

- Password input for BUSY device API token, submit over same-origin JSON; no localStorage/sessionStorage token persistence. Session cookie controls subsequent requests and EventSource.
- Demo mode must be visibly labeled and talk only to the isolated mock BUSY service. Demo seed data is never confused with real aircraft or real device state.
- Initial loading, invalid token, connected/streaming, disconnected/reconnecting, config conflict, empty queue, grouped details and one-time credential states are implemented.
- Re-render safely using DOM text/React escaping, preserve form edits/focus while SSE arrives. Reduced-motion setting disables decorative state transitions.

## Intentional deviations from concept

The concept's browser frame, fictional domain/serial/firmware, fixed sample counts and fake actions are not product content. Use actual authenticated state. No browser chrome recreation. Device selection is shown as the single authenticated device rather than a nonfunctional switcher. Include protocol-required exit/heartbeat settings missing from the compact concept. Language and copy can be adjusted for accurate state meaning.

## Verification

Use Chrome for testing. Capture desktop and narrow viewports. Compare actual render with concept: header/brand, 2:1 layout, hierarchy, color, table density and service form alignment. Exercise sign-in, two clients receiving SSE, service registration and policy changes, revision conflict, queue expansion/pause/end, and logout. State whether upstream is mock or real. Do not infer device acceptance from UI success.
