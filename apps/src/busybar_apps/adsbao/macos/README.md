# Native location helper

`BusyBarLocation.app` uses macOS Core Location. Build it without launching it:

```sh
.venv/bin/python scripts/build-location-helper.py
codesign --verify --strict .venv/BusyBarLocation.app
```

The default output is ignored under `.venv/`. The build uses the installed Xcode
Command Line Tools, targets macOS 11 or later, and signs ad hoc with the stable
application identifier and designated requirement `app.busybar.location`. It does
not modify any existing credential helper or Keychain item.

The Python `start_location_helper(repo, runtime, request_authorization=False)`
launches the signed bundle executable directly so that its process can be stopped
and reaped reliably. The helper checks `Bundle.main.bundleIdentifier` before using
Core Location. Only an explicit `request_authorization=True` invocation may activate
the app and call `requestWhenInUseAuthorization()`, once, while authorization is
undetermined. A regular observer never requests authorization. An undetermined
background request writes its status and exits, releasing the singleton lock so
a later explicit setup can request permission in another process. Denied,
restricted and disabled services also report status and exit. Authorized watches
continue updating until stopped; the observer can start a new helper after
explicit setup. No privacy settings are changed.

The only location output is
`~/Library/Application Support/BusyBarAI/location.json`. Other `--runtime` paths
are refused. The directory is mode 0700, and a new mode-0600 temporary file is
atomically renamed for every snapshot. A separate private flock file prevents two
helper processes from writing concurrently. Coordinates never go to stdout or
stderr. There is no network location fallback.

Authorized watch mode requests continuous updates at approximately 100-metre
accuracy without a movement-distance filter. It restarts native acquisition once
the last fix reaches 120 seconds, with at least 60 seconds between attempts, so a
stationary Mac can request a fresh fix before expiry. Cached callbacks keep their
original Core Location timestamps; restarting never retimestamps coordinates. A fix must be at most 300 seconds old with horizontal accuracy between
0 and 500 metres. Status reports distinguish `not_determined`, `denied`,
`restricted`, `services_disabled`, `acquiring`, `timeout` and `unavailable`.
An expired fix is replaced by an explicit status. Python validates the snapshot
again and only exposes allowlisted status/quality metadata in diagnostics.

For native troubleshooting, the bundled executable also accepts `--once` and
`--timeout 30` (5–120 seconds). `--once` exits after a usable fix, a terminal
unavailable status, or the acquisition timeout. Native authorization is still
opt-in through `--request-authorization`. Building, signing and Python mocks do
not establish successful live permission or location acquisition.

Apple references, checked 2026-10-14:

- [Requesting authorization](https://developer.apple.com/documentation/corelocation/requesting-authorization-to-use-location-services)
- [macOS NSLocationUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocationusagedescription)
- [NSLocationWhenInUseUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocationwheninuseusagedescription)
