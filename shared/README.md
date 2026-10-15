# Shared BUSY Bar Components

This directory contains device and rendering code used by both checkers.
It does not contain Codex lifecycle rules or aircraft proximity rules.

| Module | Purpose |
|---|---|
| `api` | Authenticated cloud requests and scoped display cleanup. |
| `credentials` | Cloud and local-input Keychain access. |
| `device_input` | Local protobuf button stream over Wi-Fi or USB. |
| `wifi_setup` | Private device address and local-token setup. |
| `frames` | Actual device framebuffer decoding. |
| `graphics` | Pixel text, native clock font, and XPM encoding. |
| `native` | Native bicycle0 sections, smooth progress, and alpha fade masks. |

Both checkers use the same fade generator and native file encoder.
The device plays the stored frames.
The Mac does not send one request for each animation frame.

Run the complete suite from the repository root:

```sh
.venv/bin/python scripts/run-tests.py
```
