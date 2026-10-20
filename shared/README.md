# Shared BUSY Bar Components

This directory contains device and rendering code used by the agent checker, the notifier, and the apps.
It does not contain agent lifecycle rules or notification rules.

| Module | Purpose |
|---|---|
| `api` | Authenticated cloud requests and scoped display cleanup. |
| `credentials` | Cloud and local-input Keychain access. |
| `device_input` | Local protobuf button stream over Wi-Fi or USB. |
| `wifi_setup` | Private device address and local-token setup. |
| `frames` | Actual device framebuffer decoding. |
| `graphics` | Pixel text, native clock font, and XPM encoding. |
| `native` | Native bicycle0 sections, alpha fades, damped rolls, and staggered character rolls. |
| `lease` | A display lease in device storage, so several Macs can share one Bar. |
| `command` | Local command-line tools with a timeout and a short error message. |

All components use the same fade generator and native file encoder.
The device plays the stored frames.
The Mac does not send one request for each animation frame.

Run the complete suite from the repository root:

```sh
.venv/bin/python scripts/run-tests.py
```

`activity.ActivityPublisher` provides the shared occurrence lifecycle for Agent and game renderers. It keeps identity, freshness, pending native updates, and withdrawal separate from source detection and cloud scheduling.

`cloud.Producer` indexes scoped receipt keys once per snapshot and reconciles the matching local occurrences under the state lock. Repeated receipt history does not rescan the entire outbox for each receipt. The durable state uses one JSON encoding for both its 32 MiB byte limit and atomic file write; failed saves retain the previous file and receipt transitions remain retryable. Urgent fallback, replay protection, and callbacks still depend on the same durable transitions.
