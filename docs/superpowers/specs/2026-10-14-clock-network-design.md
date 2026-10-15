# Reference clock and network speed

User direction: preserve the approved icons, match the attached BUSY clock, replace gray date/elapsed text with upload/download speed, and remove WORK/WAIT and other state words.

Use the firmware 1.2.4 BUSY Bold 7 font (OFL 1.1) at its native pixel size for the front clock. Keep source icon at x=0, clock at x=20/y=1, gray compact ↑/↓ rates at y=9 and the existing native reciprocating strip at y=15. No textual task-state labels on either screen. Back screen shows source, clock and explicitly labeled byte rates. Clock/network remain visible when tasks are idle, with no fabricated active task or animation.

Network scope is this Mac's default routed interface, not the BUSY device, Wi-Fi link capacity or an internet speed test. Sample local cumulative byte counters with route/netstat every five seconds; divide byte deltas by monotonic elapsed time. First sample, interface changes, counter resets and read errors show --; do not invent zero traffic. Compact B/K/M/G denote bytes per second with binary scaling. Source icons, native animation behavior, Keychain credentials and priority/namespace rules stay as approved.

Acceptance: exact native clock font, no state words, readable nonoverlapping rates, reset-safe real measurements, idle clock persists, previous animation still moves; full tests and actual frame inspection before publication.
