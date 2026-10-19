# Shared service motion

Cloud service changes use one control-plane transition, independent of app,
template or priority group. The target is a 200 ms fade to black followed by a
200 ms black hold. The phase clock uses monotonic elapsed time, with persisted
progress as a lower bound after eviction. The device plays a preuploaded native
fade; the host sends one start draw rather than HTTP opacity samples. Following
that acknowledgement, a conservative 200 ms monotonic completion fence precedes
the 200 ms black hold. Device HTTP latency and retries can extend these targets;
the WAN API cannot guarantee exact physical 200 ms intervals. Where existing
unpinned animation slots or cache capacity are unavailable, a single opaque XPM
draw and 200 ms black hold provide a bounded hard-cut fallback; that path does
not satisfy smooth fading and is not labelled as a successful fade.

Short completion/black fences now wait inside the active dispatch, with a
persisted recovery alarm. Each wake reloads the current generation and rechecks
monotonic elapsed time; a timer callback alone cannot complete a phase. This
avoids adding Durable Object alarm delivery latency to each 200 ms stage. It
does not remove the incoming native HTTP request after black, so it is not a
device-local 200 ms scene switch.

Before this scheduling change, a read-only hardware framebuffer probe observed
three complete black intervals of approximately 3.6–5.5 seconds on the front and
back service regions. It retained only black/nonblack values and request time
bounds, not private screen pixels. A matching control-plane trace showed a
nominal 400 ms pair of fences taking about 2.7 seconds before the incoming draw;
that draw then acknowledged about 3.9 seconds later. These are separate timing
observations, not proof that ACK latency equals physical black duration. The
revised deployment still requires a new hardware timing measurement.

| Event | Behavior |
| --- | --- |
| Natural end or rotation | Stop charging the outgoing dwell budget; exit, black, then enter the next candidate. |
| Higher group preempts | Change the pending candidate immediately. Reuse an exit already in progress, so candidate churn does not restart 400 ms. |
| Interrupted service resumes | Keep its remaining dwell budget, and run a fresh entrance before charging it. |
| Queue becomes empty | Finish exit and black before clearing this application's namespace and returning to the device default. |
| Same occurrence changes content | Keep the occurrence, generation and current entry; send the latest content delta. |
| Cold start | Enter directly; there is no outgoing content to fade. |

The compositor covers the 72×16 front and 160×80 back service canvas with black
native animation masks, or XPM masks on the capacity fallback. Device-owned status icons may remain visible. Old native scrolling
text is neutralized under black, then selectively retired. Normal incoming draws
atomically make the masks transparent alongside the new content, so a delayed
retirement request cannot hide the whole entrance. Crowded scenes use the
bounded staged handoff. Existing generation, ownership and acknowledgement
fences still determine what counts as displayed. Each new exit uses fresh native
widget IDs: firmware does not restart a finished animation merely because its
section changes on the same path. Unmasking explicitly sets opacity to zero.
Native fade assets only reuse historical unpinned animation slots; they do not
consume a new immutable slot extension or reduce the original 16-slot limit.

All six current local registrations use the same 540 ms coin projection through
the common cloud scene adapter: Agent status, Agent requests, ADSBao, World of
Warcraft, WoW Forever and MapleStory. Only the icon rectangle turns about its
vertical axis twice, slows and stops on its normal face. Agent icons occupy
14×14 pixels at (14,1); notification/game icons occupy 16×14 pixels at (0,1).
The service card, clock, counters and text never rotate. The reverse is darker
and mirrored, and the edge remains at least one pixel wide. The pure projection
function takes elapsed seconds; the native icon asset samples it at 50 FPS.
PR63 text motion remains independent: agent digit rolls and fades are unchanged;
notifications retain the original character entrance, detail at 300 ms and native
scrolling text. The notification entrance duration still follows its original
text sequence and can exceed the icon's 540 ms. Entrance completion uses the
scene duration/acknowledgement boundary, not a host frame counter.

The two-turn curve is θ(t)=4π(1−t/0.54)³, with angular speed
ω(t)=12π/0.54·(1−t/0.54)². Speed starts at 4000°/s and decreases
continuously to zero at 540ms. Sampling at50FPS uses the firmware's exact20ms
integer timer period. The largest adjacent angle change is about77.1° (below
90°), compared with about113.5° at the former25FPS/720ms setting; the fast
front/reverse/edge sequence is therefore better resolved without adding turns.
The largest16×14 raw icon animation stays below26KiB, with the same asset/slot
count and unchanged16-slot/two-MiB device budget.

| Time | Remaining angle | Angular speed |
| --- | ---: | ---: |
| 0ms | 720° | 4000°/s |
| 60ms | 505.7° | 3160.5°/s |
| 120ms | 338.8° | 2419.8°/s |
| 240ms | 123.5° | 1234.6°/s |
| 360ms | 26.7° | 444.4°/s |
| 480ms | 1.0° | 49.4°/s |
| 540ms | 0° | 0°/s |

The inspected firmware player schedules one frame callback using `1000/fps` and
pauses on its finished flag; the service layer still sends `loop:false` and
retains the transparent renewal target. That wrapper contains no frame-skipping
policy. Actual render cadence and any decoder-internal catch-up remain hardware
observations, not a guarantee from the encoded FPS or this preview.

![Continuous angular deceleration](images/icon-spin-speed.png)

Complete recovery scenes retain the entry asset for actual re-entry. A later
transparent replacement is the native renewal target, so a long-lived service
cannot restart its entrance during TTL renewal. Incremental value/clock updates
do not contain that entry asset. Reduced-motion local scenes remain static.
Third-party publishers that build their own scenes must provide their own entry
asset or adopt the shared adapter; the control-plane exit still covers them.
Standalone presenters retain their existing animations.

![Six services: only the icon turns](images/icon-only-timeline.png)

[Animated six-service icon and original text preview](images/icon-only-six-services.gif)

These previews compose the actual icon/text assets with synthetic timing and a
local approximation for firmware text widgets. Each sampled frame verifies that
the icon compositor changes no pixels outside its icon rectangle. They are not
measurements of WAN latency or physical device acceptance. The ADSBao source and registration identity remain `adsbao`; its new
16×14 mark is a white top-view aircraft with jade radar arcs.

![ADSBao old and new mark](images/adsbao-icon-before-after.png)

Codex metadata access remains blocked and is outside this animation release.
The existing Codex unknown-rate behavior and PR63 reply-throughput fixes remain
unchanged. This release adds no data feed, hook or session-directory access.

## Controlled device preview before deployment

Temporary synthetic occurrences were sent through the existing binding and
withdrawn or confirmed terminal afterwards. This did not install the new observer
or control-plane code. Earlier firmware captures confirmed the previous full-front coin asset playback,
the new ADSBao mark and z-index 255 black masks on both service canvases.
Firmware-owned status icons remained visible alongside the black back canvas.

[Historical full-front coin capture, superseded](images/actual-service-coin.gif)

This historical capture does not validate the corrected icon-only entrance.
New icon-only hardware acceptance remains separate from these offline previews.

![Actual back service canvas under the opaque mask](images/actual-service-black-back.png)

These captures establish asset/display compatibility. The new exit scheduler's
200/200 ms boundaries are verified with an injected monotonic clock and mocked
native acknowledgements; physical WAN transition timing still needs acceptance
after a reviewed deployment. These animation captures do not establish live
Codex throughput.


A revised native fade preview used two small RLE assets (front 526 B, back
4166 B), fresh widget IDs and explicit opacity-zero unmasking. The actual front
capture contained gray levels 100 → 99 → 49 → 0; the full back service region
also reached black, and unmasking restored gray 100. The screenshot request
itself sometimes took 218 ms, so these samples demonstrate intermediate dimming
and coverage rather than exact physical 200 ms timing. The seven asset samples
span 0…200 ms at 30 FPS. Device-owned status icons remained visible.

![Actual native fade samples with request-start timestamps](images/actual-native-fade-frames.png)

![Actual full back canvas after native fade](images/actual-native-fade-back.png)

The earlier five-widget/raw-asset prototype failed actual-device checks (missing
back coverage and no captured intermediate dimming) and is not the final design.
A fresh-layer, slow-animation diagnostic showed all gray levels. Because that
probe changed both widget identity and initial alpha, it did not establish a
specific firmware alpha/cache defect. The final path conservatively starts at
alpha 1/255 and uses new IDs for each exit. Same-path section changes alone are
known not to restart the installed firmware's finished animation.
