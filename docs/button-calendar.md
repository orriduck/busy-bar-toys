# Start/Pause, native calendar and standby — 2026-10-14

Requested behavior: Start/Pause restores the original device calendar, keeping it there until the next task turn. While in Codex mode: thinking is blue vertical motion, approval/input waiting is a stationary yellow glow, and standby is a full-height white light. Completion/interruption enter standby. Unknown/error stay gray/red rather than being mislabeled idle.

Implementation:

- A local WebSocket listener uses the official `busylib==2.6.0` generated protobuf schema and the firmware's `/api/status/ws` stream. Only START PRESS dismisses; release, OK, Back and unrelated states do not. Input zero-valued enum fields are decoded correctly. Press consumption is synchronized to avoid losing an event between poll and reset.
- A private atomic view file persists calendar mode and every observed turn identity, including stale turns. Only a newly active turn resumes drawing. Old stale turns becoming active again cannot seize the screen. The listener remains active in calendar mode.
- Local connections retry with bounded backoff; rejected local authentication stops retries. Stop cancels the listener and releases its socket. Status exposes a separate `button_input.connected` flag, with stale/unwritable diagnostics treated conservatively.
- Firmware 1.2.4's DELETE handler shadows its JSON application-name variable. Cleanup now uses the supported query scope `DELETE /display/draw?application_name=ai-status` with no JSON body, so it cannot accidentally clear another app due to that parser bug.
- Static lights retain their brightest core in the transmitted palette; the waiting glow is visibly yellow and standby spans every physical row in white.

Validation completed:

- 80 local tests passed, including actual loopback WebSocket handshake/START filtering/shutdown, concurrent press consumption, diagnostic-write failures, persistent dismissal, stale heartbeat suppression, new-turn resume and observer integration.
- Device rendering verified the white full-height standby and yellow approval glow. Native blue motion remains the existing verified animation. Clearing only this app restored the original firmware calendar, captured below.
- Visual inspection confirmed all three lights and readable clock/network values. The state cards are explicitly labeled on-device demos; they do not represent the current task lifecycle.

**Acceptance still pending: physical Start/Pause on this device.** At this check the USB address was unreachable, direct local Wi-Fi HTTP was unreachable, and a cloud stream-ticket exchange using the existing BAR token returned 401. The installed listener therefore reports `button_input.connected=false`. Color updates are live; button switching cannot work until a local input connection is available. The process automatically retries the documented USB address, so connecting a data cable does not require a code change. No Wi-Fi password, device access mode, network routing or account settings were changed, and no new tokens were created.

![Original calendar and explicitly labeled device state demos](images/actual-standby-states.png)

Official sources checked 2026-10-14:

- [SDK local-only stream and input decoding](https://github.com/busy-app/busylib-py/blob/main/src/busylib/client/state_stream.py)
- [Input protobuf enums](https://github.com/busy-app/busybar-protobuf/blob/dev/input.proto)
- [Firmware canvas input behavior](https://github.com/busy-app/busybar-firmware/blob/1.2.4/applications/services/canvas/canvas.c)
- [Firmware DELETE namespace parser](https://github.com/busy-app/busybar-firmware/blob/1.2.4/applications/services/web_server/http_api/api_display.c)
