# Connect a Mac to BTC

[简体中文](cloud-mode.zh-CN.md)

Open [BTC](https://btc.orriduck.workers.dev). The cloud backend controls the Bar. Each Mac collects local states and sends content to its registered service IDs. A device key lets the browser view all computers. Pairing lets it change only one computer’s services.

## Prepare the client

From the repository root:

```sh
.venv/bin/python -m pip install -e .
swiftc scripts/cloud-keychain.swift -o .venv/bin/busy-cloud-keychain
```

The computer credential stays in Keychain under `app.busybar.control-plane.computer`, account `busy-bar`. `~/Library/Application Support/BusyBarAI/cloud-computer.json` contains IDs, epochs and local routes. It contains no credentials. Keep this directory private. Never put keys or enrollment tickets in command arguments, Git or chat.

## Connect a new computer

1. Sign in with a device API key. Open **Services → Connect computer**.
2. Create an enrollment ticket. It expires after five minutes.
3. Run the command below. Enter the ticket at its hidden prompt.

```sh
.venv/bin/busy-bar cloud-enroll --url https://btc.orriduck.workers.dev
```

The client saves its computer credential before the enrollment request. If the reply is lost, repeat the command with the same ticket. The client checks the saved credential first. It does not create another computer identity.

Register the sources this Mac uses:

```sh
.venv/bin/busy-bar cloud-register codex --name Codex --template agent
.venv/bin/busy-bar cloud-register adsbao --name ADSBao --source adsbao
```

For configured GitHub or Datadog collectors, register their own services. This does not enable or configure those external tools:

```sh
.venv/bin/busy-bar cloud-register github --name GitHub --source github
.venv/bin/busy-bar cloud-register datadog --name Datadog --source datadog
```

Use the collector’s actual local source name. `cloud-register` prints the registered service ID. A local Notifier can also use any existing service ID owned by this computer:

```sh
.venv/bin/busy-bar cloud-route SOURCE SERVICE_ID
```

One computer credential can publish arbitrary app labels and content to any of its owned service IDs. The backend does not map app names to services. The Mac controls that map. Restart the observer after changing registrations or routes. A source without a route stays disabled and reports a setup warning.

## Pair the browser

```sh
.venv/bin/busy-bar cloud-pair
```

Paste the five-minute, one-use code into **Connect computer → Pairing code**. The server records the binding. A browser preference cannot grant access. Sign out before pairing a different computer. Sign out removes the browser binding; it does not stop local services.

**Configuration** shows three global groups and every computer's services. Drag only your own services between groups. All services in a group have equal priority. Other computers remain visible and read only.

- **Interception** interrupts either lower group immediately. Use it for pages that need the screen now.
- **Follow queue** plays queued work without interrupting the active message in that group. Equal services queue by arrival time. A new arrival does not interrupt the current same-group occurrence. A source-ended message must be ended by its host before the queue advances.
- **Dispensable** shows background status while the higher groups are empty. All eligible services alternate by each service's Hold, including services on the same computer.

A service's group is global. A row's position and its computer do not create another priority within a group. Higher groups preserve the interrupted occurrence and its remaining budget. Source urgency cannot promote a message above its registered group. Only native-confirmed visible time after entrance consumes Hold. Source messages stay alive across turns; timed messages keep their original cumulative lifetime. Services and Configuration show source connectivity, last heartbeat, group, display state and queue count. A source that has never checked in is not marked online.

The sender declares `exit: finite|source` for each occurrence. Hold sets the Dispensable visible turn and the cumulative lifetime of finite messages. The sender decides when to send a new occurrence. Register an explicit `priorityGroup` through the API, or move the owned service in Configuration; agents initially default to Dispensable and other templates to Follow queue.

## Upgrade an existing Mac

The legacy Agent and Notifier credentials remain valid for publishing. They cannot manage services. Only upgrade the Mac you are using.

```sh
.venv/bin/busy-bar uninstall
.venv/bin/busy-bar cloud-migrate --url https://btc.orriduck.workers.dev
.venv/bin/busy-bar cloud-register codex --name Codex --template agent
.venv/bin/busy-bar cloud-register adsbao --name ADSBao --source adsbao
.venv/bin/busy-bar cloud-handover
```

Migration proves possession of every existing publisher credential for that computer. It keeps the computer and instance IDs. New services get fresh IDs. Handover requires the observer to be stopped. It keeps the old private files, ended receipts, occurrence IDs and earlier urgent deadlines. It discards cloud proofs from the old service namespace. An invalidated proof cannot extend the local fallback delay.

A queued event keeps its recovery scene and waits for a successful source poll. An event already shown is not replayed. Source-controlled content waits for fresh sampling. Action callbacks cannot move between processes; copied events do not advertise them. Unresolved local actions block handover. Keep source cursors and ADSBao encounter files. Do not delete them to force a replay.

Remove only this Mac’s retired registrations after the new services work. The backend refuses removal while remote actions remain pending, running or unknown. Each other Mac must do its own migration.

## Run and verify

```sh
.venv/bin/busy-bar watch --mode cloud
.venv/bin/busy-bar status --mode cloud
```

The foreground observer and installed observer share one lock. Do not run both. Status reads each registered service scope and local diagnostics. `submitted` means an OS notification process accepted a request; it does not prove delivery.

To start at login:

```sh
.venv/bin/busy-bar install --mode cloud
```

This replaces the existing per-user launchd command. It does not install Claude hooks. Local Codex observation continues through the existing collector. Start/Pause and live preview require their explicit service switches and the configured LAN connection.

For isolated development, use the local mock origin. Never enter real device keys into the mock stack. Mock acceptance does not prove physical display behavior.


## Agent status and input requests

Register a separate Notifier before starting an upgraded observer:

```sh
.venv/bin/busy-bar cloud-register agent-notifier --template notifier --name "Agent requests" --source agent-notifier
```

Put Agent requests and ADSBao in Follow queue, and Agent status in Dispensable. Put a dedicated Page service in Interception when it must interrupt queued work. Move only your own services between groups. There is no ranking inside a group. Status and input requests use separate registrations. Each waiting task retains its own notification; the source removes it when input is resolved. Other computers must register and route their own Notifier; this command does not change them.

To withdraw a notification, call `CloudQueue.withdraw(source, item_id)` or `RoutedCloudQueue.withdraw(source, item_id)`. The durable local outbox retries `POST /api/withdraw` until acknowledged. The HTTP body contains `instanceId`, `epoch`, `itemId`, `version`, authenticated for the matching owned service. Withdrawal retires that occurrence; a later notification needs a new occurrence.


## Restore a disconnected preview

The local bridge retries known stale-frame, rate-limit and sequence rejections with a 1–30 second backoff. Each retry opens a new stream and verifies the device again. Authentication, device identity and unknown protocol failures still stop the bridge.

Check `~/Library/Application Support/BusyBarAI/preview-status.json`. `lastCloudError` records only a known server error code. `connected`, `sent` and `timestamp` show whether the bridge is currently sending frames. A previously reported `protocol` failure does not identify its original cause; restart the local service and retain the report for diagnosis.
