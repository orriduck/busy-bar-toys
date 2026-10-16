# Compact control plane iteration

User-directed design: implement and release quickly through CI. Pause frame-rate optimization; preserve the existing keyed live preview and its reconnection/session behavior.

Services: compact device groups with service rows. Device labels use explicitly registered name prefixes such as `This Mac · Codex`; unlabelled services remain in an ungrouped section rather than inventing device identity or online status. Show each service's common enable, credential and revoke actions. Move allowInput/allowPreview controls here with plain labels `Bar buttons` / `Live preview` and explanatory accessible text. Configuration has no enable/capability toggles.

Configuration: descending-priority sortable rows, visible grip and rank; pointer/touch/keyboard operation through dnd-kit. Click the row summary to expand its mounted editor (preserves drafts), exposing hold/exit/snooze/heartbeat and numeric priority. Drag persists one atomic all-service order with expected config revision; validate the entire permutation before mutation. On conflict/failure preserve the server order and show the existing mutation error. Changes to urgency semantics are excluded: urgent messages still go first.

Queue: App, Sender, Received remain, Received becomes HH:mm:ss. Add compact priority badge and a thin row-bottom playback indicator. Finite items use actual remaining/total visible time; source-controlled items show an indeterminate playing indicator, never a fabricated countdown. Indicate only confirmed healthy display ownership and stop extrapolation after its confirmation expires. Preserve member details/actions.

Device: Sign out uses existing destructive Button variant. Keep 90% default density and fixed dock on other desktop pages; mobile stays in flow. No production credentials/configuration are modified during visual tests; mock environment exercises writes.

Acceptance: relevant model/runtime/UI tests, typecheck/build, browser desktop/mobile plus real production navigation. Test local atomic reorder, keyboard/pointer sorting, toggles, dirty draft preservation, conflict handling and progress states; then CI, production deployment, PR merge and stable checkout sync. Frame-rate target remains deferred.
