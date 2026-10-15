# Local clients for the control plane

[简体中文](cloud-mode.zh-CN.md)

Cloud mode sends local agent states and notifications to the control plane. The control plane owns the device display, queue, grouping, snooze, and calendar return. Source tools and their credentials stay on the Mac. The default mode remains `standalone`.

Use the [production management page](https://busy-bar-control-plane.orriduck.workers.dev) for real collectors. The shared cloud preview accepts synthetic data only. Mock acceptance does not prove physical display behavior. These steps configure and migrate one Mac; repeat them with a separate service registration on each Mac.

## 1. Prepare the client

Use the project virtual environment. From the repository root, run:

```sh
.venv/bin/python -m pip install -e .
swiftc scripts/cloud-keychain.swift -o .venv/bin/busy-cloud-keychain
```

Build this helper once. Rebuild it only when its Swift source changes. This step does not rebuild the existing device-token, input-token, or location helpers. The helper uses these Keychain services:

| Role | Keychain service | Account |
| --- | --- | --- |
| Agent | `app.busybar.control-plane.agent` | `busy-bar` |
| Notifier | `app.busybar.control-plane.notifier` | `busy-bar` |

## 2. Create the services

Open **Services** on the control-plane page. Register one **agent** service and one **notifier** service. Open **Configuration** to set their policies. Keep the notifier priority above the agent priority. The page defaults are agent 10 and notifier 50. Keep the default exit policy unless you need different behavior.

Copy the publisher credential shown for each service. Each credential belongs to one service. The page shows it once. Do not put it in a shell command, environment variable, repository file, or chat.

## 3. Configure each local role

For the local demo, run:

```sh
.venv/bin/busy-bar cloud-setup --url http://localhost:8787 --role agent --instance mac-agent
.venv/bin/busy-bar cloud-setup --url http://localhost:8787 --role notifier --instance mac-notifier
```

For a hosted control plane, replace the origin with its HTTPS origin:

```sh
.venv/bin/busy-bar cloud-setup --url https://YOUR-CONTROL-PLANE.example --role agent --instance mac-agent
.venv/bin/busy-bar cloud-setup --url https://YOUR-CONTROL-PLANE.example --role notifier --instance mac-notifier
```

Enter the matching publisher credential at the hidden prompt. Setup validates a scoped snapshot. It stores the secret in Keychain and writes only service metadata to a private file. Setup does not change the installed service or send a device request.

The instance name is optional. Without `--instance`, setup retains the previous name or creates a stable name. Keep the name and issued epoch across restarts. One role can run alone. Configure both roles to run both collectors.

The local urgent fallback delay is 10 seconds by default. Set a whole number from 1 to 300 seconds for either role:

```sh
.venv/bin/busy-bar cloud-setup --url http://localhost:8787 --role notifier --fallback-seconds 17
```

This value is saved as nonsecret `fallbackSeconds` metadata and survives restart. Existing metadata without this field uses 10 seconds. Changing the setting does not reset an existing occurrence deadline.

URLs must be origins. Paths, user information, query strings, fragments, and redirects are refused. HTTP is allowed only for loopback development.

## 4. Run in the foreground

The current observer and cloud observer share one process lock. Stop the current observer before you start cloud watch. On an installed standalone system, this command removes the old launchd registration and retains its credentials:

```sh
.venv/bin/busy-bar uninstall
.venv/bin/busy-bar watch --mode cloud
```

Use Control-C to stop cloud watch. Stop retains occurrence IDs, snooze state, action results, and urgent deadlines. A quick restart renews the same occurrences. If the backend lease expires first, its tombstones suppress replay until a confirmed source clear or a new agent turn. The client never clears the device namespace.

Check cloud status from another terminal:

```sh
.venv/bin/busy-bar status --mode cloud
```

This command reads the control plane. It does not need a BUSY device token. The result is scoped to each configured service. Local diagnostics include the last OS notification outcome and up to eight recent outcomes, even if the backend is unavailable. `submitted` means the notification process accepted the request; it does not prove notification permission or user delivery.

To reduce motion, use:

```sh
.venv/bin/busy-bar watch --mode cloud --reduced-motion
```

## 5. Install only when ready

Foreground testing does not install cloud mode. To start it at login, explicitly run:

```sh
.venv/bin/busy-bar install --mode cloud
```

This command uses the existing per-user launchd label. It replaces the installed watch command. It validates the cloud metadata and does not read a device token, build helper programs, or change source credentials. Keychain access is checked when the observer starts.

To restore standalone mode later, stop cloud watch and run:

```sh
.venv/bin/busy-bar install --mode standalone
```

Standalone mode requires its existing BUSY device token.

## Management pages and live display

- **Display:** the current front display and the queue. Each row shows App, Sender, and Received. Open the app to read details and use queue controls.
- **Services:** register collectors and replace or revoke publisher credentials.
- **Configuration:** enable services and set priority, exit, hold, later, and heartbeat rules.
- **Device:** inspect connection, current controller, API confirmation, and preview diagnostics. Sign out here.

Sender means the registered service name. An instance name distinguishes Macs that share a registration. It is not the author of the source notification. Received is the server receipt time for that occurrence. Updates retain it. Hover over the time for the full date and time.

For live display preview, update the designated Mac to this version and restart cloud watch. In **Configuration**, enable **Live display preview bridge** for one service on that Mac. Prefer its agent service. The Mac must have the existing local Wi-Fi input configuration and Keychain helper. The bridge verifies the Bar identity before it reads pixels. It does not draw on the Bar or forward local credentials to the browser or cloud.

The preview targets 30 fresh captures per second. It reads the actual 72 by 16 front framebuffer. It does not replay a scene or invent animation. Actual rates depend on local Wi-Fi, internet, and browser scheduling. **Device** shows the recent received rate and the last browser sample. These values are measured, not a fixed 30 fps label. Browser latency uses the Mac and browser clocks.

Capture starts only while an authenticated **Display** page is visible. Leaving the page, hiding the tab, or closing the browser stops demand. A lost close signal expires within six seconds. Closing the browser does not stop cloud scheduling. Without an available Mac bridge, the page says that preview is unavailable; the cloud can still control the Bar.

The bridge keeps private counters in `~/Library/Application Support/BusyBarAI/preview-status.json`. Capture and send rates in that file are runtime averages. The file contains no pixels, local address, or credentials. Frames stay in memory and do not enter durable cloud storage. Disable the preview bridge to stop capture without disabling that service's notifications or device-button input.

## Input and local actions

Cloud watch can read the existing Wi-Fi input configuration. Configure that input in standalone mode first if needed. Cloud watch does not configure it or use the default USB endpoint. In the control-plane service settings, enable **Trusted device button bridge** for exactly one local listener. Its service and instance can differ from the current display owner. Start/Pause then sends a stable event ID and current generation to `/api/input`. The backend decides whether to run the urgent primary action or clear existing nonurgent items.

Primary callbacks run on the Mac that advertised them. For example, a Datadog callback uses the local `pup` command. The executor checks the service, instance, item, generation, and advertised key. It saves an action ID before the side effect. An interrupted action becomes **unknown** after restart and is never retried automatically. Running and terminal results stay in the durable outbox until delivery. An unavailable callback reports failure and cannot claim success.

## Delivery and urgent fallback

The notifier adapter publishes every raw source item. State sources become conditions. Event sources become events. Original source group keys are retained inside the notifier service. Aircraft use a persisted encounter ID: repeated polls and restarts retain it; a confirmed outside-radius rearm or daily rearm creates a new ID. The backend owns ordering and snooze. A manual clear tombstones the occurrence; a heartbeat cannot revive it. Delivery expiry also prevents cloud replay, but retains an unresolved urgent item's local fallback text and deadline until source clear or fallback notification. A confirmed state clear followed by recurrence creates a new occurrence UUID.

A failed source poll retains the last condition as uncertain and stops its renewal. A successful poll has a bounded freshness window based on its next expected poll. A stuck source cannot renew cached data forever. Source `on_shown` callbacks run only after confirmed cloud admission.

The client captures the existing native renderers. Notification scenes contain the complete entrance, detail at 0.3 seconds, and the final view. Animation files upload as content-hash `anim` assets. Oversized back bitmaps use lossless PNG assets. Agent clock and network changes use native updates and keep a complete recovery scene.

The urgent watchdog runs separately from HTTP, SSE, and source polling. Its default deadline is 10 seconds from local recognition. Matching device confirmation, a valid queue proof, or exact admitted membership coverage can defer a local macOS notification. Proofs have finite expiry. Repeated copies do not reset the deadline. On proof expiry or owner exit, the fallback deadline is at most another configured delay (10 seconds by default). Pause and disable suppress fallback. Recognition time, deadline, and notification dedupe survive restart. Runtime timing uses a monotonic clock with a persisted UTC mapping; a backward wall-clock change cannot reset the deadline. Current UTC also advances effective time after Mac sleep, so expired proofs cannot survive suspend. The confirmation means an acknowledged API write; it is not a physical pixel check.

## Troubleshooting

- **Keychain unavailable:** unlock Keychain, allow access to the compiled helper, then restart. Background reads fail without opening a permission prompt.
- **Setup required:** repeat `cloud-setup` for the missing role. Replace the credential after the administrator reissues it. The new issued epoch starts a new local producer session.
- **Unauthorized:** check the role credential. The producer stops authentication retries. It does not fall back to direct device writes.
- **Observer already running:** stop the existing observer. Both modes share `watch.lock`.
- **Waiting:** inspect cloud status and the queue page. Another urgent item can own the display while yours has a valid waiting proof.
- **Source error:** check the local source tool. Cloud mode does not copy its credentials to the control plane.

Local metadata and durable outboxes are under the existing `~/Library/Application Support/BusyBarAI` runtime directory. They have mode 0600 and can contain notification text. They do not contain publisher credentials. Do not delete them to retry an action or bypass a manual clear.

Local retention is bounded: 128 cached assets / 8 MiB, 4096 occurrence or pending end IDs, 512 action IDs, 2048 pending input IDs, and 32 MiB total state. Inactive assets use LRU reclamation. Ended presentation content is compacted; replay and action dedupe IDs are retained. Capacity exhaustion is an explicit error and does not silently discard pending work.
