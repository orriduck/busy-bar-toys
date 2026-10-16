# UI component audit and BUSY theme

Baseline: main `399ee8f`. Scope: Display, Services, Configuration, Device, sign-in and credential dialogs. Keep the existing React/Vite, Tailwind v4, TanStack Query/Table and shadcn `base-nova` stack.

## Inventory

The baseline contains 23 shadcn source modules. An installed module must also be composed correctly and share the app theme.

| Area | Baseline | Final composition |
| --- | --- | --- |
| Actions and navigation | Button with BUSY variants | Keep Button and shared action/disclosure variants. Keep semantic navigation and the existing persistent preview layout. |
| Registration enums | Select and NativeSelect | Use one SettingsSelect composition of shadcn Select. Remove NativeSelect. |
| Exact numbers | Input with a different material from Select | Restore official sources. Compose InputGroup/InputGroupInput with Badge/NumberFlow. The labelled native input stays mounted, shows native text on focus and overlays its decorative badge. |
| Priority and timing | Slider with application labels | Keep Base UI track/thumb/input behavior. Use compact capsule styling, preset dots and named detents. |
| Form layout | FieldGroup/Field/FieldLabel | Keep; use FieldContent and FieldDescription for related content. |
| Service groups/rows | Hand-styled div surfaces | Compose Card for computers and Item/ItemGroup/ItemSeparator for services. |
| Revoke confirmation | Inline div/buttons | Use AlertDialog, with pending/error state and explicit focus restoration. |
| Row actions | DropdownMenu | Keep; put items in DropdownMenuGroup. |
| Configuration disclosure | Collapsible with keepMounted | Keep drafts across disclosure and navigation. |
| Queue | TanStack Table and shadcn Table | Keep; use Badge for Playing and Progress for finite/unknown playback. |
| Action divider | CSS border/footer surface | Use Separator. Show Save/Discard only for dirty drafts; disable Discard during requests and preserve focus when actions disappear. |
| Credentials/errors/loading/help | Dialog, Alert, Empty, Skeleton, Tooltip | Keep. Use a shared small Button for help triggers. |
| Generic icons | Manual SVG and app artwork | Use Lucide for UI icons; keep actual ChatGPT/Claude/Your dot marks. |
| Device facts and actual pixels | Definition list, canvas and device shell | Keep semantic facts and the domain renderer; a generic component cannot replace device pixels. |
| Unused modules | Checkbox, Toggle, ToggleGroup | Remove unused modules. Label stays an internal Field dependency; Separator gains application consumers. |

The missing compositions were added through the official shadcn CLI before applying the shared Tailwind theme. Page CSS owns geometry and domain annotations, not alternate control materials.

## Final policy layout and ownership

Priority, Hold and Heartbeat are the only policy controls. Each shows a label, editable value Badge and slider. Wide panels use one row of three; narrower panels use two or one column. Preset text hides in the widest arrangement to prevent collisions; dots, native titles and slider value text retain named preset information. There is no numeric preset dropdown.

Exit and Later are absent from settings. Registration explains that the sender declares each message's finite/source lifetime and decides when to send again. New publishers send `exit` per occurrence. Completed finite conditions do not auto-snooze or replay; persisted legacy snoozed items are completed on the next tick. Legacy service fields and publishers remain compatible. See `control-plane/PROTOCOL.md`.

The capsule track is 18px and white thumb 21.6px at approved 90% density. Root padding accommodates centered thumb overhang without depending on hidden-panel measurements. Pointer positions within 3% of a preset snap to it; keyboard moves remain directional and stop at crossed presets. Exact native input precision is retained; readouts show up to six decimal places.

NumberFlow animates policy values, order ranks and custom priority values. Scoped useGSAP decorates Priority with severity colors/bubbles, Hold with a settling highlight, and Heartbeat with a pulse. Decoration changes no setting or playback timer. Motion uses transforms/opacity, pauses offscreen or in a hidden document, honors reduced motion and cleans up observers/listeners/timelines.

## Theme reference

Read-only inspection of `https://cloud.busy.app/api-tokens`, including its Create token dialog, on 2026-10-15. The dialog was closed without creating a token.

- Background `#0a0a0a`, charcoal workspaces, blue primary actions and neutral secondary actions.
- Reference inputs/selects approximately 48px high, 9px corners and 16px type, translucent charcoal fill, subtle inset top highlight and outline.
- Cards/dialogs 24px corners; primary buttons use pill shapes. BUSY red remains the logo color.
- Preserve the approved 90% density, stable computer IDs, This computer binding, help and one persistent actual-pixel preview.

Input/Select/InputGroup share one control surface. Embedded inputs add no second outline. The quiet numeric variant exposes its surface on hover/focus. Colors are semantic tokens.

## Validation

TypeScript, production build, lifecycle/model tests and independent code review passed. Browser checks covered actual pointer snapping, keyboard escape from detents, exact and long fractional edits, Badge/native-input synchronization, NumberFlow's running 450ms animations, reduced motion, hidden-panel pause, dirty drafts/Discard, revoke Cancel/Escape focus, registration dropdowns, keyboard reorder, and finite/unknown Progress. At 390px, the document measured 375px with no horizontal overflow. No browser console error/warn was observed.

All mutation checks used local synthetic services. Production verification must not submit user drafts, rotate credentials, revoke services or alter policies. Screenshots stay outside the public repository.
