# Continuous device handoff

A selected scene used to queue a full namespace DELETE before its first draw. The dispatcher then uploaded assets. During that interval, no remote widget remained, so the device returned to its calendar.

A normal scene change now retains the acknowledged outgoing widgets and their asset pins. The dispatcher reserves and uploads all assets for the incoming entrance before changing the screen. It replaces compatible element IDs in place, then selectively removes outgoing IDs that are absent from the incoming first draw. A late outgoing ACK still updates the native inventory so its widgets are retired. The incoming scene is not confirmed until both its entrance and retirement batch acknowledge. Hold and finite lifetime accounting keep their existing confirmation fences.

A shared ID that changes widget type keeps the existing selective-clear behavior. A temporary one-pixel black anchor retains the remote application if that clear would otherwise empty it. The anchor is removed after the incoming draw. If the two scenes cannot share the bounded native asset slots or element inventory, the dispatcher releases the outgoing scene through the same anchor before loading the next scene. This exceptional path can show a short black interval; it does not expose the calendar or overwrite a playing asset.

An empty queue still clears the application and returns to the calendar. Cold start, recovery from an in-flight command after a crash, and a sent draw whose response is uncertain retain a full clear and complete replay. These recovery paths can briefly show the calendar because the server cannot safely infer the device's widgets. Recovery retains retry backoff and does not count unconfirmed time.

The regression device is a mock. It records an empty native application after each request and rejects a same-ID type change without a selective clear. Tests cover same-ID/new-ID/type-change handoffs, delayed multi-command asset preparation, a late old-generation ACK, bounded slot reclamation, uncertain responses, and return to calendar when no scene remains. No mock scene is sent to production by these tests.
