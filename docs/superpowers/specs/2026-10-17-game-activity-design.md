# Game activity indicators — proposed design

Status: approved for self-review and execution by the user on 2026-10-17. Self-review complete. Implementation and production registration will be independently verified.

## Scope

1. State the real browser session duration on the sign-in page.
2. Add separate WoW, WoW Forever, and MapleStory services on this Mac.
3. Share activity-session publishing behavior with the Agent checker.
4. Explain how a phone can identify the existing Bar/computer connection after delivery. Keep the existing ownership boundary.

## Browser sign-in

Show: **Stay signed in on this browser for 30 days.** Signing out or clearing site data ends the session earlier. This duration belongs to the BTC browser session. It is not the lifetime of the BUSY Device API token.

Use one browser-session policy value for the server and the UI so the copy cannot drift. Preserve encrypted token storage, HttpOnly cookie use, logout revocation, and the separate pairing proof.

## Approach

Recommended: use a small shared activity-session layer between source adapters and cloud publication. It owns occurrence identity, renewal, updates, and withdrawal. Agent adapters keep task/turn state, token accounting, and MotionDirector. Game adapters keep app detection and elapsed time. Both keep the existing Producer, display lease, queue, and native animation primitives.

Alternatives considered:

- Three independent game checkers: easy to start, but duplicates lifetime and withdrawal logic.
- Treat games as Agent tasks: fewer new interfaces, but assigns task/turn/token concepts to apps that do not have them.

Do not create another display arbiter. Cloud scheduling remains authoritative.

## Game detection

Use macOS running application metadata. Match the actual client bundle path as well as its identity. The two installed WoW clients share `com.blizzard.worldofwarcraft`; their bundle ID alone is insufficient.

Proposed source mapping:

| Source | Actual client | Display title |
| --- | --- | --- |
| wow | WoW `_retail_` client | WOW |
| wow-forever | WoW `_classic_beta_` client | WOW FOREVER |
| maplestory | MapleStory client under the installed launcher | MAPLESTORY |

Ignore launchers, voice helpers, browser helpers, and updater processes. App names, file paths, and process inventory stay local. Publish only the recognized game identity and activity duration. If app metadata cannot be read, mark the source unknown; do not infer an exit or fabricate a running game.

Apple source checked 2026-10-17: [NSRunningApplication](https://developer.apple.com/documentation/appkit/nsrunningapplication) exposes `bundleURL`, `launchDate`, `processIdentifier`, and termination state. Its dynamic properties require normal run-loop updates; stale objects must not be treated as proof that an app is still running.

## Sessions and time

Default proposal: count while the game client is running, including in the background. This measures client-open time, not AFK detection or confirmed in-world play.

- Start when a recognized game client opens.
- Use its real launch metadata when the observer starts after the game.
- Keep the same occurrence while it remains open. A heartbeat or elapsed-time update does not restart the entrance.
- Withdraw promptly when the last matching client exits.
- A fresh launch creates a new occurrence and resets its timer.
- Multiple running games publish independent activities; existing Hold rotation selects between them.
- Keep a stable session across observer restarts. Never resume an old session solely from an outbox if the client is no longer running.
- Validate PID plus launch identity, rather than PID alone.

Handle sleep/wake and clock changes explicitly in tests. Show an honest elapsed value; do not invent foreground or keyboard activity.

## Services and display

Register three separate owned services, all in **Dispensable**. Use source-controlled end semantics. Preserve the configured Hold duration and global preemption behavior.

At the start of a display admission, show bold `GAMING`, then roll into the English game title with the existing staggered character animation. Show the elapsed time below from the start of the entrance. Use native scrolling for a title that does not fit, rather than compressing it into unreadable pixels. Reuse an original pixel game-controller icon and a restrained game accent.

Update only the time region during a session. Do not replay GAMING or reset scrolling on every time update. Return to another queued service or the native calendar when the game exits, using the existing seamless handoff path.

## Phone and ownership

Keep device-token authentication distinct from computer pairing. A phone session can see the Bar and registered computers without inheriting a desktop browser's ownership proof. Do not automatically pair it or relabel it as the physical Mac. During delivery, verify the current UI and explain how the short computer ID, service group, and Bar identity establish which connection is visible. If management access is desired, the existing one-use pairing flow remains explicit.

## Acceptance

- Sign-in page states the actual 30-day browser session and renders without overflow on phone and desktop.
- Retail and Forever clients do not collide despite their shared bundle ID. Launchers produce no game activity.
- Open/background/exit/reopen, multiple clients, multiple games, observer restart, unknown reads, sleep/wake, and clock changes have regression coverage.
- Shared publication preserves Agent status/Notifier separation and TPS semantics, tombstones, admission proofs, and pending deltas.
- A game time update does not create a new queue occurrence or restart the title animation.
- All three services appear on this Mac's production registration as Dispensable, with no changes to the other Mac.
- Mock previews are labeled. Real app observation, actual device frames, production deployment, and CI are verified separately and reported accurately.
- Keep the protected producer-serialization stash untouched. Use personal-author commits and normal fast-forward integration, with Cloudflare native builds.

## Self-review decisions

Keep native detection local and use a bounded background sampler. Use launch identity plus the boot session and a continuous clock to survive collector restart, PID reuse, sleep, and wall-clock changes. Unknown or stale samples stop source renewal. Persist only the three recognized sessions in the private runtime. Share occurrence/delta publication with the Agent renderer; do not refactor its task discovery or TPS calculation.
