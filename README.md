# BUSY Bar AI Status

Show local Codex task status on a BUSY Bar.

The front display shows a source icon, a clock, and one network rate.
The clock uses New York time and a 24-hour format.
The layout matches the device calendar.

![Device calendar and Codex display](docs/images/actual-calendar-alignment.png)

## Read the display

| Indicator | Meaning |
|---|---|
| Moving blue light | A task is in progress. |
| Yellow light | A task needs input or approval. |
| Thin white light | The display is in standby. |
| Red light | A task reported an error. |
| Gray light | No task update arrived for 30 minutes. |
| Orange up arrow | The Mac sent data during the last sample. |
| Cyan down arrow | The Mac received data during the last sample. |
| Dark arrow | That direction has no measured activity. |

The ChatGPT icon identifies standard Codex tasks.
The five-dot icon identifies Your dot tasks.

The network number is the sum of upload and download rates.
The program reads the Mac's default network interface every five seconds.
It does not run a speed test.
The back display shows separate UP and DN rates.

| Front unit | Full unit |
|---|---|
| B | B/s |
| K | KiB/s |
| M | MiB/s |
| G | GiB/s |

`--` means that a rate is not available.
A first sample, an interface change, or a counter reset can cause this indication.

## Return to the calendar

A completed or interrupted task enters standby.
After ten seconds, the program restores the device calendar.
A new task turn restores the Codex display.
Updates from an old turn do not restore it.

Start/Pause also restores the calendar when the local button connection is available.
Automatic return does not need this connection.

## Requirements

- macOS.
- Python 3.10 or later.
- The Swift compiler.
- A BUSY Bar with internet access.
- A cloud API token for that device.

## Install the program

Use these commands in the repository directory.

1. Create the Python environment.

   ```sh
   python3 -m venv .venv
   ```

2. Install the package.

   ```sh
   .venv/bin/python -m pip install -e .
   ```

3. Compile the cloud token helper.

   ```sh
   swiftc scripts/store-token.swift -o .venv/bin/busy-token-store
   ```

4. Compile the local input helper.

   ```sh
   swiftc scripts/input-keychain.swift -o .venv/bin/busy-input-keychain
   ```

5. Store the cloud token.

   ```sh
   .venv/bin/busy-bar token-set
   ```

6. Check the cloud connection.

   ```sh
   .venv/bin/busy-bar status
   ```

7. Install the background service.

   ```sh
   .venv/bin/busy-bar install
   ```

The service starts now and at login.
The first Keychain read can show a permission dialog.
Approve that dialog on the Mac.

## Configure Wi-Fi button input

The Mac must be able to connect to the BUSY Bar on the local network.
A cloud connection alone cannot receive button events.

1. Save the local input configuration.

   ```sh
   .venv/bin/busy-bar input-wifi
   ```

2. Restart the service.

   ```sh
   .venv/bin/busy-bar install
   ```

3. Check the input connection.

   ```sh
   .venv/bin/busy-bar status
   ```

The input connection is ready when `button_input.connected` is `true`.
The selected transport is in `button_input.transport`.
A saved configuration does not prove that the connection is ready.

The setup command creates or reuses a local access token.
It does not change the device access mode or password.
Run setup again if DHCP changes the device address.
Without Wi-Fi configuration, the program uses the USB address `10.0.4.20`.

## Check or stop the service

Show device and service status:

```sh
.venv/bin/busy-bar status
```

Remove the background service:

```sh
.venv/bin/busy-bar uninstall
```

This command keeps the Keychain entries.

Run the observer in a terminal:

```sh
.venv/bin/busy-bar watch
```

Service log: `~/Library/Logs/BusyBarAI/service.log`.
Private runtime directory: `~/Library/Application Support/BusyBarAI`.

## Task sources

The observer reads local Codex Desktop and CLI lifecycle events.
It extracts identifiers, source, project directory name, and timestamps.
It does not store prompts or tool output.
Subagents do not get separate display entries.
A failed tool command does not mean that the task failed.

Your dot identification uses explicit local Orbit metadata.
Use `watch --dot-thread THREAD_ID` for a manual identity override.
Identity alone does not indicate activity.

Cloud-only Your dot tasks need an event bridge to this Mac.
Browser ChatGPT conversations are not monitored.
Local Codex log formats can change after an update.

## Send lifecycle events

Use one session ID and one turn ID for each real task turn.

```sh
.venv/bin/busy-bar emit working --source dots --session-id THREAD_ID --turn-id RUN_ID --project my-project
.venv/bin/busy-bar emit waiting --source dots --session-id THREAD_ID --turn-id RUN_ID --project my-project
.venv/bin/busy-bar emit done --source dots --session-id THREAD_ID --turn-id RUN_ID --project my-project
```

The commands write local metadata.
The observer sends the display data.
A cloud task must be able to run these commands on this Mac.

### Optional Codex hooks

`busy-bar hook` reads structured hook data from standard input.

| Hook | State |
|---|---|
| UserPromptSubmit, PreToolUse, PostToolUse | working |
| PermissionRequest | waiting |
| Stop | done |
| Interrupt | stopped |

Add a handler to each required event in `~/.codex/hooks.json`.
Replace the example path with the absolute repository path.
Keep all existing hooks.

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/ABSOLUTE/PATH/busy-bar/.venv/bin/busy-bar hook",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

Review and trust new hooks through the normal Codex process.
The program does not change hook trust records.

## Preview and capture

Create a local preview:

```sh
.venv/bin/busy-bar preview --output .local/preview
```

Stop the observer before a device demo:

```sh
.venv/bin/busy-bar uninstall
```

Show a five-second demo:

```sh
.venv/bin/busy-bar demo --source dots --state waiting --seconds 5
```

Start the observer after the demo:

```sh
.venv/bin/busy-bar install
```

Capture the actual device displays:

```sh
.venv/bin/busy-bar capture --output .local/device
```

The back display labels demos as DEMO.
A demo is not a task status report.

## Credentials and display ownership

The cloud token is in Keychain entry `app.busybar.ai-status`.
The local input token is in `app.busybar.local-input`.
Secrets pass through standard input or captured output.
The program does not put them in command arguments, configuration files, or logs.

Runtime directories use mode 0700.
State and event files use mode 0600.
The Wi-Fi configuration contains only the device address.

The program owns display namespace `ai-status` at priority 50.
It clears only that namespace.
Device focus modes have a higher priority.
An HTTP 409 response makes the program yield the display.
Display elements expire after 15 seconds without a refresh.
Connection failures use a bounded retry delay.
Authentication failures stop retries.

## Verification

Run the tests:

```sh
.venv/bin/python -m unittest discover -s tests -v
```

Device checks used firmware 1.2.4 and API 27.5.0 on 2026-10-14.
See the [layout checks](docs/centered-glow.md), [button checks](docs/button-calendar.md),
[standby timeout check](docs/standby-timeout.md), and [compact display check](docs/compact-standby.md).

## References

- [BUSY HTTP API](https://docs.busy.app/bar/dev/http-api).
- [Firmware 1.2.4 API schema](https://api.busy.app/busybar/openapi.yaml?Name=1.2.4).
- [Codex hooks](https://learn.chatgpt.com/docs/hooks).
- [Official ChatGPT icon](https://help.openai.com/en/articles/7905742-what-does-the-official-chatgpt-ios-app-icon-look-like).
- Writing style: [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/).

The ChatGPT icon belongs to OpenAI.
The five-dot mark is an original project asset.
This project is independent of OpenAI and BUSY.
