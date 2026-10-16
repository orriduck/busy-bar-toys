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

Priority, Hold, Later, and Heartbeat each have one always-visible Slider and an exact InputGroup value. No dropdown duplicates the slider. Desktop uses two columns; small screens use one. Exit remains an enum Select. Shared small controls are 40px high before the approved 90% density.

## Verification

Check consistent computed materials within shared default/small control sizes; dropdown keyboard selection; exact input/slider synchronization and named detents; Discard and dirty-draft preservation; existing revoke confirmation/cancel; DnD order save; one mounted preview; actual pixel rendering; and390px layout without horizontal overflow. Use local synthetic data for mutations. Production checks must not submit user drafts, rotate credentials, revoke services or change policies.

## Completed validation

- 200 tests across 19 files passed; TypeScript and the production build passed.
- Browser: pointer drag within 2% of Normal returns exactly 50; outside the snap zone can reach intermediate values. ArrowRight from 50 advances to 54. Discard resets the form.
- Desktop: two policy columns. At 390px: one column, document width375px, no horizontal overflow. No browser console warnings/errors observed.
- Use the Slider default center alignment: the previous edge prehydration mode could leave thumbs/indicators hidden when loaded inside a collapsed, keep-mounted panel. Visible sliders and their range inputs were verified after opening the panel.
- Existing library Select keyboard behavior, draft preservation, revoke Cancel/Escape focus restoration, finite/unknown Progress, and keyboard DnD save were checked with local synthetic services.
