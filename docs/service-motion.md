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

All six current local registrations use the same 720 ms coin projection through
the common cloud scene adapter: Agent status, Agent requests, ADSBao, World of
Warcraft, WoW Forever and MapleStory. The full front turns about its vertical
axis twice, slows and stops on its normal readable face. The reverse is darker
and mirrored, and the edge remains at least one pixel wide. The pure projection
function takes elapsed seconds; the native asset samples it at 25 FPS. Entrance
completion is a duration/acknowledgement boundary, not a host frame counter.

Complete recovery scenes retain the entry asset for actual re-entry. A later
transparent replacement is the native renewal target, so a long-lived service
cannot restart its entrance during TTL renewal. Incremental value/clock updates
do not contain that entry asset. Reduced-motion local scenes remain static.
Third-party publishers that build their own scenes must provide their own entry
asset or adopt the shared adapter; the control-plane exit still covers them.
Standalone presenters retain their existing animations.

![Shared coin projection timeline](images/shared-coin-timeline.png)

[Animated coin preview](images/shared-coin-preview.gif) ·
[Exit/black/entry visual preview](images/exit-black-coin-preview.gif)

These previews are synthetic time-curve illustrations, not measurements of WAN
latency. The ADSBao source and registration identity remain `adsbao`; its new
16×14 mark is a white top-view aircraft with jade radar arcs.

![ADSBao old and new mark](images/adsbao-icon-before-after.png)

Codex metadata access remains blocked and is outside this animation release.
The existing Codex unknown-rate behavior and PR63 reply-throughput fixes remain
unchanged. This release adds no data feed, hook or session-directory access.

## Controlled device preview before deployment

Temporary synthetic occurrences were sent through the existing binding and
withdrawn or confirmed terminal afterwards. This did not install the new observer
or control-plane code. Actual firmware captures confirmed native coin playback,
the new ADSBao mark and z-index 255 black masks on both service canvases.
Firmware-owned status icons remained visible alongside the black back canvas.

[Device coin capture](images/actual-service-coin.gif)

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
