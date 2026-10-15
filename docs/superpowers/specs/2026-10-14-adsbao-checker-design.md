# ADSBao checker design

## Goal

Keep the existing Codex checker and add a nearby-aircraft checker in this repository.
Show an aircraft alert when a fresh airborne position is within three statute miles
(4,828.032 metres) of this Mac. After the alert, restore the current Codex view or
the original device calendar. The user selected this restoration rule on 2026-10-14.

## Repository and ownership

- `codex-checker/`: Codex lifecycle, source icons, clock/network layout, standby rules,
  and their tests.
- `adsbao-checker/`: location acquisition, ADSBao stream, proximity detection,
  aircraft view, mock scenarios, and their tests.
- `shared/`: BUSY transport, credentials, input handling, native animation encoding,
  fades, display coordination, and shared tests.
- One installed Python environment and one background service coordinate both
  checkers. Keep the existing CLI, launchd identity, Keychain entries, and private
  calendar latch. No second process competes for the same display namespace.

Refactor the existing files before adding the aircraft flow. Preserve the current
Codex behavior and all applicable tests. Update install paths and CI discovery.

## Location and data

Use a small macOS Core Location helper with an application identity and a location
usage description. The first authorization is handled by the macOS permission UI.
Store the latest location only in the user's private runtime directory. Reject
denied, invalid, old (over five minutes), or poor (over 500 metres) fixes. Do not
substitute IP geolocation or a mock position for a real fix. Expose location status.
An explicit coordinate override supports tests and a fixed observation point.

Use the existing public ADSBao endpoint:
`https://adsbao.dev/events/nearby/coordinates/{lat}/{lon}`.
Subscribe to the rounded coordinate channel used by the frontend; calculate exact
local distance from the actual location fix. Reconnect with bounded backoff and
replace the stream if the location channel changes. Do not modify ADSBao production
or copy its closed-source upstream implementation.

Accept fresh `nearby:snapshot` and `nearby:traffic` aircraft payloads. Ignore stale,
pending, malformed, out-of-order, old, and on-ground positions. Position age must be
at most 60 seconds. Use great-circle horizontal distance, not altitude or nautical
miles, for the three-mile boundary. A healthy empty result means no nearby aircraft;
a failed stream means data unavailable.

## Alerts and screen flow

Select the nearest newly eligible aircraft. Prefer its callsign; fall back to its
registration or ICAO hex. Show a pixel aircraft flying into its resting position,
with the flight identity and distance. Include aircraft type when available. Share
the existing native animation encoder and fade components. Keep native playback
on the device instead of sending frames over the network.

Hold a visible alert for ten seconds, then fade out. Resume the current Codex
presentation if its calendar latch permits it; otherwise release to the firmware
calendar. Codex state and standby deadlines continue to update while an alert is
visible, but invisible standby does not consume its ten-second visible hold.
New task events must not repeatedly restart an aircraft animation.

An aircraft alerts once per encounter. Re-arm it after it has been outside a
3.5-mile boundary for at least 60 seconds. Rate-limit repeated alerts across
reconnects and service restarts with bounded private metadata. Limit pending work
to one nearest fresh candidate; do not accumulate an alert backlog. Start/Pause
dismisses the current alert and follows the existing calendar behavior.

Reduced-motion mode uses a static aircraft and direct display changes. Missing
location or ADSBao connectivity leaves the Codex checker and calendar functional.

## Validation and delivery

Use a deterministic mock stream and a mock observation point for an end-to-end demo.
Label synthetic values as DEMO on the back display and in captures. Cover points
just inside/outside three miles, stale fixes, ground targets, deduplication,
re-entry, stream errors, restoration, button dismissal, and reduced motion.
Verify the shared native file structure and retain the existing Codex tests.

Capture a finite real-device mock demo, inspect its frames, and restore the normal
service afterward. Test a real ADSBao stream separately from the mock. Actual
macOS authorization may require the user to allow the helper; a mock demo does not
establish live location acceptance. Document this distinction and all commands in
short technical English. Push the validated work to the same repository.

## Evidence checked on 2026-10-14

- Current Codex checker source and the user's physical Start/Pause acceptance.
- ADSBao frontend coordinate request and SSE payload model in the local repository.
- A live public sample stream returned `nearby:snapshot` and fresh `nearby:traffic`
  envelopes, with `aircraft.ac`, flight identity, coordinates, and `fixAt` fields.
  The sample used a published Boston example, not this Mac's current location.
- Apple: https://developer.apple.com/documentation/corelocation/requesting-authorization-to-use-location-services
- Apple: https://developer.apple.com/documentation/bundleresources/information-property-list/nslocationwheninuseusagedescription
