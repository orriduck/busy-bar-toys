# Control plane implementation

Approved scope: [v5](control-plane-v5.md), issue #10. Baseline main@93e0688.

1. Backend: typed protocol, persistent per-device queue/scheduler, encrypted credentials/sessions, service registration and policy revisions, SSE snapshots, actions, allowlisted serialized BUSY dispatcher with bounded assets and alarms. Test scheduler and Worker/DO runtime.
2. Local integration: explicit cloud mode, scoped credential storage, complete agent/notifier presentations using current renderers, uploads/updates, SSE resync and buttons/actions, durable urgent watchdog independent of connection. Preserve standalone mode and default runtime until deliberate migration. Test without hardware.
3. Browser management: device sign-in, registration and service controls, owner/health, expandable event queue with states/ETA, SSE and conflicts. Test with mock device and real local Worker runtime.
4. Integration/review: spec then quality review for each phase, cross-client/scheduling/failure/restart tests, existing Python suite, bilingual setup/migration/recovery docs and CI. Create reviewable PR.
5. Release: deploy to authenticated intended Cloudflare account, verify browser/backend with mock device; only after reviewable result migrate real device via new backend token and old-token revocation with both Mac clients ready. Report unavailable account/second-Mac prerequisites accurately.

No historical SSE replay or hardware screenshot preview in MVP. No Claude hooks on this Mac. No credentials in repo, argv or logs.
