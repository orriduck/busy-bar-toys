# UI component audit and BUSY theme

Baseline: main `399ee8f`. Scope: Display, Services, Configuration, Device, sign-in, and credential dialogs. The existing React/Vite, Tailwind v4, TanStack Query/Table, and shadcn `base-nova` stack stays in place.

## Inventory

The baseline contains 23 shadcn source modules. Having a module installed is not enough: the application must compose it, and its shared theme must remain consistent.

| Area | Baseline implementation | Decision |
| --- | --- | --- |
| App actions and navigation | shadcn Button; BUSY variants | Keep Button. Theme its shared variants. Keep semantic nav and the persistent preview layout; the Sidebar component adds collapse/mobile behaviors this app does not need. |
| Enum settings | Mixed Select and NativeSelect | Use shared shadcn Select for Exit, registration Computer, and Template. Remove NativeSelect. Numeric policy fields have no dropdown. |
| Text and exact numbers | shadcn Input, but old material differs from Select | Restore official source first. Put exact numbers and units in InputGroup, beside each slider label. |
| Timing and priority | shadcn Slider with application preset labels | Keep the library track/thumb, pointer/keyboard behavior and accessibility. Preset labels are domain-specific annotations, not a replacement slider. Pointer positions within three percentage points snap to a named preset. Arrow keys move monotonically and stop at crossed presets. |
| Form structure | FieldGroup, Field, FieldLabel | Keep and use FieldContent for related controls. |
| Service groups and rows | Hand-styled section/header/row divs | Use Card composition for each computer and Item composition for each service. |
| Revoke confirmation | Inline div with confirm/cancel buttons | Replace the existing confirmation with AlertDialog; retain pending/error and revision behavior. |
| Row actions | DropdownMenu | Keep; place items in DropdownMenuGroup. |
| Configuration disclosure | Collapsible, including keepMounted | Keep. Preserve unsaved drafts across disclosure and navigation. |
| Queue data | TanStack Table plus shadcn Table | Keep. Domain sorting, grouping, timestamps and actions stay unchanged. |
| Playback indicator | span with manually maintained progressbar role | Replace with shadcn Progress, including unknown duration. |
| Status chips | Badge plus plain Playing text | Keep Badge; use it for Playing as well. |
| Form action divider | CSS border on a div | Use Separator and a normal action row; no separate gray footer surface. |
| Credentials | Dialog, Input, Textarea | Keep; retain focus restoration, one-time secret handling and copy controls. |
| Errors and empty/loading states | Alert, Empty, Skeleton | Keep; no custom replacements needed. |
| Form help | Tooltip | Keep. Use a shared Button size for its trigger, without per-page icon styling. |
| App icons | Hand-drawn generic SVG paths and official app marks | Use the existing Lucide library for generic UI icons. Preserve actual ChatGPT/Claude/Your dot artwork. |
| Device facts | Semantic definition list | Keep semantic HTML; no equivalent component improves this mapping. |
| Actual device preview | Pixel canvas and BUSY device shell | Keep the domain renderer and single mounted preview. A generic component cannot replace actual device pixels. |
| Unused baseline modules | Checkbox, Toggle, ToggleGroup | Remove modules with no application or component consumer. Label remains an internal Field dependency. Separator gains an application consumer. |

## Execution order

1. Record this inventory and replace the missing component compositions using the official shadcn CLI.
2. Apply the BUSY appearance in shared components through Tailwind and semantic tokens. Page CSS owns geometry, not alternative input/button materials.
3. Verify behavior and inspect desktop/mobile screenshots before merging and allowing Cloudflare Workers Builds to publish.

## Theme reference

Read-only inspection of `https://cloud.busy.app/api-tokens`, including its Create token dialog, on 2026-10-15. The dialog was closed without creating a token.

- Background: `#0a0a0a`; workspace: charcoal; blue primary and muted neutral secondary actions.
- Official form inputs and selects: approximately48px high, 9px corners, 16px text, translucent charcoal fill, subtle inset top highlight and outline.
- Main action: rounded pill; dialog secondary actions: approximately40px high.
- Cards/dialogs: 24px corners and quiet inset highlights. BUSY red remains the logo color.
- Preserve this app's approved90% density, compact service grouping, new stable computer IDs, question-mark help and persistent real preview.

Shared Input, InputGroup, and Select must use one control surface definition. InputGroup owns its input's unit and focus treatment. Button owns action variants. Card/Item own surfaces and row composition. Colors remain semantic tokens; no page-level control skin overrides.

## Compact policy layout

Priority, Hold, Later, and Heartbeat each have one always-visible Slider and an exact InputGroup value. No dropdown duplicates the slider. Desktop uses one row of four numeric controls, with Exit spanning a separate bottom row. Narrow panels fall back to two or one column. Exit uses shadcn Tabs on wide panels and Select on narrow panels; both share one controlled value. Small screens put label/value above each slider. Shared small controls are 40px high before the approved 90% density. Exact values appear in the existing Badge component with NumberFlow. A labelled native InputGroupInput overlays the badge; on focus the badge becomes invisible without changing its footprint, and native text appears for exact editing. Embedded inputs have no second control surface. Save/Discard appears only for a changed draft.

## Verification

Check consistent computed materials within shared default/small control sizes; dropdown keyboard selection; exact input/slider synchronization and named detents; Discard and dirty-draft preservation; existing revoke confirmation/cancel; DnD order save; one mounted preview; actual pixel rendering; and390px layout without horizontal overflow. Use local synthetic data for mutations. Production checks must not submit user drafts, rotate credentials, revoke services or change policies.

## Completed validation

- 200 tests across 19 files passed; TypeScript and the production build passed.
- Browser: pointer drag within 2% of Normal returns exactly 50; outside the snap zone can reach intermediate values. ArrowRight from 50 advances to 54. Discard resets the form.
- Desktop: four sliders in one compact row, Exit on its own row. At 390px: label/value above each slider, document width375px, no horizontal overflow. No browser console warnings/errors observed.
- Use the Slider default center alignment and padding for the pill thumb: the previous edge prehydration mode could leave thumbs/indicators hidden when loaded inside a collapsed, keep-mounted panel. Visible sliders and their range inputs were verified after opening the panel.
- Existing library Select keyboard behavior, draft preservation, revoke Cancel/Escape focus restoration, finite/unknown Progress, and keyboard DnD save were checked with local synthetic services.

- Refined row layout: quiet exact-value inputs share their InputGroup surface; no nested input outline remains. Pristine forms omit the action footer. Discard is disabled during a pending request; successful Save and Discard move focus to the persistent named form, with the next Tab reaching About Priority. Both paths were exercised in the local browser.

- Final Slider theme follows the user’s reference: thick capsule track, larger white thumb, blue fill, and named detent dots inside the track. Track/thumb remain Base UI primitives; no custom pointer implementation.
- `@number-flow/react` animates setting readouts, order ranks and custom priority values. Exact native inputs remain accessible; animation is hidden from assistive technology for the duplicate readout and native text is shown on focus. Actual browser animations were observed at450ms. Reduced-motion emulation produced no running NumberFlow animations. Fractional values remain exact in the input; the readout allows up to six decimal places.
- Final browser checks: thick-track pointer58% gives66; dragging back to52% snaps50. Desktop Tabs selection survives narrowing to the mobile Select. At390px, document width375px with no horizontal overflow. Console had no error/warn. Value cells were widened to retain long fractional timing readouts.

- Semantic motion uses scoped `useGSAP`: Priority interpolates its named severity colors and floats bubbles; Hold slows and settles a highlight; Later sends delayed marks right; Heartbeat pulses. Animation changes only decoration, never a setting or playback timer. Beams/marks use transforms and opacity. IntersectionObserver and document visibility pause offscreen/hidden panels; matchMedia and cleanup remove timelines/listeners under reduced motion or unmount. Actual hidden-panel style snapshots stayed identical across checks; reduced-motion decoration opacity was zero with no transforms.
- Exit desktop Tabs use the shared large size (48px before90% density), with increased horizontal padding. Mobile retains Select. Final390px check had375px document width and no console warnings/errors.

- Compact sizing supersedes the initial large-pill trial: actual track18px, thumb21.6px at approved90% density, matching12px source padding for endpoint overhang; quiet values use shared xs InputGroup. The initial compact trial retained2×2 and measured190.8px. The final layout below supersedes that arrangement.

- Final compact layout: four numeric fields in one desktop row (label, editable value Badge and slider), Exit on row2. Container thresholds fall back to2/1 columns. Wide preset text is hidden to avoid collisions, while detent dots, title and aria-valuetext retain preset information. Actual pristine form height104.4px. Browser verified Badge editing84→keyboard88, full-range fractional timing without document overflow, Discard, and390px single-column/375px document width. Independent review passed.
