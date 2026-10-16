# Configuration presets and native deployment

The user requests Cloudflare-native Git deployment, unique computer identifiers, a This computer badge, colored priority presets, Custom-only snapping sliders, timing presets/help, and a compact save area. Preserve all existing scopes, draft/revision fences, scheduler semantics and persistent preview. FPS optimization stays paused.

Use Workers Builds for main only, root control-plane, build npm test && npm run typecheck && npm run build, deploy npx wrangler deploy. GitHub Actions remains tests only. Configure the existing production Worker, not a new stack, and verify a main build actually deploys. Browser dashboard login and Git integration consent may require user action.

Persist at most32 authenticated publisher instance IDs per service, learned from valid heartbeat messages. These are collector IDs, not hardware serials. Current installations deliberately share one instance ID across roles; new role setup reuses its peer role ID by default, while explicit and existing IDs are never rewritten. Slider keyboard steps must exceed the snap deadband; Discard and clean external policy changes reset the selected Custom mode. Group by those IDs; fallback to live items during mixed rollout, and service ID when no computer has connected. Never infer this computer from a display name. Store a user-selected local computer binding per Bar in browser localStorage, with explicit bind/clear controls and no credentials.

Priority presets Low10, Normal50, High100, Critical1000 and Custom. Colors distinguish preset levels; numeric values remain the wire contract and never supersede urgent semantics. Dragging keeps its exact existing order values; intermediate values display Custom.

Hold presets5s/10s/30s/1m; Later5m/15m/30m/1h; Heartbeat30s/60s/90s/180s. Only Custom expands a shadcn slider with useful snapping stops plus an exact number input; retain full protocol bounds and fractional legacy timing values. All timing controls have question-mark tooltips for hover/focus/touch.

Use shared shadcn ToggleGroup, Tooltip and Slider. Place timing controls in readable rows, not cramped equal cells. Replace the padded CardFooter with a compact in-form right-aligned save/discard row. Preserve dirty state and conflicting revisions.

Verify useful helper/runtime regressions, browser preset/custom/tooltip/draft interactions, mobile overflow, actual deployment and source identity rollout. Do not modify production service policy for QA.
