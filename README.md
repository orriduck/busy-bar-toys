# busy-bar-toys

English | [简体中文](README.zh-CN.md)

Show local AI agent status and short notifications on a BUSY Bar.
One background service controls every app.
The device calendar is the default view.

![Aircraft animation with mock data](docs/images/staggered-flight-preview.gif)

This rendered preview uses mock flight data.
See the [actual device capture](docs/images/actual-staggered-intro.png) for comparison.

## Components and apps

| Component | Display | Apps |
|---|---|---|
| [Agent checker](agent-checker/README.md) | Task status, source icon, clock, and network rate. | Codex, Your dot, Claude Code |
| [Notifier](notifier/README.md) | Short alerts with a split-flap entrance. | ADSBao, Datadog, GitHub, Jira, Metaflow, Terminal, Credentials, Calendar |

See [all apps and their requirements](apps/README.md).

### Agent status

Start a task in a configured agent app to show its status.
The clock uses New York time in 24-hour format.
Colored arrows show upload and download activity.
The number shows their combined rate on the Mac's default network interface.

| Light | State |
|---|---|
| Moving blue | The task is in progress. |
| Yellow | The task needs input or approval. |
| Thin white | The task is complete or stopped. |
| Red | The task reported an error. |
| Gray | The last task update is more than 30 minutes old. |

After ten seconds in standby, the service restores the calendar.
Press Start/Pause to restore the calendar immediately.
The next task turn restores the agent display.

### Nearby aircraft

The Mac supplies its system location.
The service receives nearby traffic from [ADSBao](https://adsbao.dev) through Server-Sent Events (SSE).
The trigger distance is three statute miles, or 4,828 metres, measured horizontally.

The aircraft enters beside `ADSBAO`.
After half a second, characters roll upward to the flight identity from left to right.
Adjacent characters start about 67 milliseconds apart.
The lower line shows only the aircraft type, such as `A320`.

The full introduction takes about 1.77 seconds.
The flight identity then stays visible for ten seconds.
The service restores the current agent display or the calendar.
Each aircraft alerts once per encounter.

### Notifications

Every notification uses the aircraft entrance with an app icon.
The icon background shows the level: red is urgent, amber needs attention, and the app color is information.
Other items return to the agent view or the calendar after ten seconds.
Urgent items stay until their condition clears.
Start/Pause runs the action of an urgent item, for example a Datadog page acknowledgement.
On other items, Start/Pause dismisses all notifications and shows the calendar.
See the [notifier rules](notifier/README.md).

## Requirements

- macOS with Python 3.10 or later.
- Apple command-line tools with `swiftc` and `xcrun`.
- A BUSY Bar with internet access and a BUSY cloud API token.
- A local Wi-Fi or USB connection for Start/Pause input.

Keep the Mac awake and connected to the internet.
Wi-Fi button input requires local access between the Mac and the Bar.
The devices can use different Wi-Fi bands if the network permits this access.

## Install

Keep this checkout after installation.
The service runs from its Python environment.
The command name remains `busy-bar`.

1. Clone the repository.

   ```sh
   git clone https://github.com/orriduck/busy-bar-toys.git
   ```

2. Open the repository directory.

   ```sh
   cd busy-bar-toys
   ```

3. Create the Python environment.

   ```sh
   python3 -m venv .venv
   ```

4. Install the package in editable mode.

   ```sh
   .venv/bin/python -m pip install -e .
   ```

5. Compile the cloud credential helper.

   ```sh
   swiftc scripts/store-token.swift -o .venv/bin/busy-token-store
   ```

6. Compile the button credential helper.

   ```sh
   swiftc scripts/input-keychain.swift -o .venv/bin/busy-input-keychain
   ```

7. Create a token on the [BUSY cloud token page](https://cloud.busy.app/api-tokens).

8. Store the token in macOS Keychain.

   ```sh
   .venv/bin/busy-bar token-set
   ```

9. Install the background service.

   ```sh
   .venv/bin/busy-bar install
   ```

The service starts immediately and at login.
Run the remaining commands from the repository directory.
After a directory move, repeat the editable installation and service installation.

## Enable Wi-Fi button input

1. Configure the Bar's local connection.

   ```sh
   .venv/bin/busy-bar input-wifi
   ```

2. Allow Keychain access if macOS requests it.

3. Restart the background service.

   ```sh
   .venv/bin/busy-bar install
   ```

The setup command reads the device address and stores the local token in Keychain.
Press Start/Pause to dismiss either toy and show the calendar.

## Enable aircraft alerts

1. Start system location setup.

   ```sh
   .venv/bin/busy-bar adsbao-location
   ```

2. Allow location access for **Busy Bar Location** in the macOS dialog.

3. Restart the background service.

   ```sh
   .venv/bin/busy-bar install
   ```

An ADSBao API key is not required.
The checker rejects old locations, inaccurate locations, stale aircraft positions, and aircraft on the ground.
See [aircraft setup and encounter rules](apps/src/busybar_apps/adsbao/README.md) for details.

## Enable notifications

1. Read the README of each [notifier app](apps/README.md) and install its tools.

2. Create the private configuration file.

   ```sh
   ${EDITOR:-vi} ~/Library/Application\ Support/BusyBarAI/notifier.json
   ```

3. Add one key for each app, for example `{"github": {}, "terminal": {}}`.

4. Restart the background service.

   ```sh
   .venv/bin/busy-bar install
   ```

Check the `notifier` key in `.venv/bin/busy-bar status`.
Run `.venv/bin/busy-bar notify-demo` to see each notification type. Stop the service first.

## Share one Bar between Macs

Several Macs can run this service for one Bar.
A display lease in device storage keeps one notification visible at a time.
Non-urgent items wait while another Mac shows a notification.
Urgent items take the display at once.
Every Mac must run the same version.

## Check or stop the service

| Action | Command |
|---|---|
| Check all components | `.venv/bin/busy-bar status` |
| Check aircraft diagnostics | `.venv/bin/busy-bar adsbao-status` |
| Use static displays | `.venv/bin/busy-bar install --reduced-motion` |
| Restore animation | `.venv/bin/busy-bar install` |
| Stop the service | `.venv/bin/busy-bar uninstall` |

Check `service_running`, `traffic.connected`, and `button_input.connected` as applicable.
Status output shows connection health and location accuracy.
The log is at `~/Library/Logs/BusyBarAI/service.log`.
Uninstalling the service retains the Keychain credentials.

## Show a mock aircraft

1. Stop the background service.

   ```sh
   .venv/bin/busy-bar uninstall
   ```

2. Play the finite aircraft demonstration.

   ```sh
   .venv/bin/busy-bar adsbao-demo
   ```

3. Start the background service again.

   ```sh
   .venv/bin/busy-bar install
   ```

The rear display labels the demonstration `DEMO`.
To create a preview without device access, run this command:

```sh
.venv/bin/busy-bar adsbao-preview --output .local/aircraft-preview
```

## Data and credentials

The service reads local agent event metadata.
BUSY cloud requests carry display images, animations, and device commands.
The aircraft connection sends rounded coordinates to ADSBao.
The exact location stays in a private local file.

| Data | Storage |
|---|---|
| Cloud token | Keychain service `app.busybar.ai-status`. |
| Local button token | Keychain service `app.busybar.local-input`. |
| Location, configuration, and events | `~/Library/Application Support/BusyBarAI`. |
| Service registration | `~/Library/LaunchAgents/app.busybar.ai-status.plist`. |

Runtime directories use mode `0700`.
Private state files use mode `0600`.
Keep tokens and runtime files outside Git.
The service clears only its `ai-status` display namespace.
Device focus modes retain their higher priority.

## Development

| Directory | Purpose |
|---|---|
| `shared` | Device API, Keychain, button input, display lease, text, and animation components. |
| `agent-checker` | Agent task registry, event spool, status display, and transitions. |
| `notifier` | Notification queue, background sources, entrance, and presenter. |
| `apps` | Agent apps and notifier apps. |
| `service` | Command line, launchd service, and display coordinator. |
| `scripts` | Native helper builds, tests, and previews. |
| `docs` | Design records and device captures. |

Run all tests:

```sh
.venv/bin/python scripts/run-tests.py
```

CI runs the suite on Python 3.10 and 3.14.
Add focused tests for code changes and run this suite before a pull request.
Keep mock data clearly identified in previews and demonstrations.

See the [agent checker](agent-checker/README.md), the [notifier](notifier/README.md), the [apps](apps/README.md), [shared components](shared/README.md), and [motion verification](docs/weighted-motion.md).

## Sources

- [BUSY HTTP API](https://docs.busy.app/bar/dev/http-api).
- [Native font source and license](shared/src/busybar_shared/assets/font-source.txt).
- [Icon notices](apps/src/busybar_apps/NOTICE.md).
- Writing principles: [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/).

This project is independent of BUSY, OpenAI, and ADSBao.
