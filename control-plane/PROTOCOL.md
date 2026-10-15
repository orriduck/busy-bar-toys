# Control plane protocol v1

All timestamps are UTC milliseconds. JSON endpoints are same-origin `/api`; no arbitrary BUSY proxy exists. Errors are `{error:code}`. 409 is a revision/stale target conflict; 413 is a bounded capacity rejection. Static assets are public, API bodies are `Cache-Control:no-store`. Native firmware draw priority is fixed 50, independent of service priority.

## Authentication

`POST /api/session {token}` verifies the token against BUSY `GET /status`, requires `device.serial_number`, derives opaque deviceId (SHA256 serial), encrypts the token with Worker `TOKEN_ENCRYPTION_KEY` (64 hex AES256), and sets Secure/HttpOnly/SameSite=Strict cookie. No device ID supplied by clients is trusted for login. `GET /api/session` returns `{deviceId}`; `DELETE /api/session` revokes this session. `SESSION_SIGNING_KEY` is a separate random Worker secret. Browser mutations require matching Origin and JSON. Cookie-authenticated writes must send `X-Busy-Device` with the deviceId currently rendered by that tab; it is checked against the verified session before any DO operation. Missing binding returns403 `DEVICE_BINDING_REQUIRED`; cross-tab cookie/device mismatch returns409 `DEVICE_SESSION_CHANGED`. Login is excluded. Logout and authenticated reads may omit the binding, but any supplied binding must match. Bearer publishers already encode their authorized device and are unaffected. Sessions expire in 12h. BUSY response bodies/tokens are never exposed.

`POST /api/services` (admin) `{id,name,template:'agent'|'notifier'|'custom',expectedRevision,config?:{enabled,allowInput,priority,visibleMs,snoozeMs,heartbeatMs,exit:'default'|'finite'|'source'}}` returns `{credential,epoch,epochExpiresAt,snapshot}`. Credential format `deviceId.serviceId.randomSecret`, hash stored only, returned once. Epoch is stable across process restarts; persist it with the credential. Epoch expires after 30 days; admin reissues via `POST /api/services/:id/credential {expectedRevision}`, which invalidates the old credential/epoch and ends its items. `PATCH /api/services/:id {expectedRevision,config}`; `POST /api/services/:id/revoke {expectedRevision}`. Config mutations require current `snapshot.configRevision`. Publisher uses `Authorization: Bearer <credential>` without cookies. Session + publisher auth cannot be mixed. Publisher is scoped to exactly one service; instanceId is fixed by first publish per item and required on heartbeats/actions/input. A designated input listener has its own stable instanceId independent of the current owner; only an admin may grant its service allowInput, default false. Service IDs and instance IDs match `[A-Za-z0-9_-]{1,64}`.

## Producer

`POST /api/publish`:

```json
{
  "instanceId": "mac-a",
  "epoch": "issued-stable-epoch",
  "itemId": "stable-occurrence-uuid",
  "version": 1,
  "firstRecognizedAt": 1792000000000,
  "kind": "event",
  "level": "attention",
  "groupKey": "optional-source-group",
  "title": "Queue title",
  "detail": "Queue detail",
  "validUntil": 1792000060000,
  "actionKeys": ["primary"],
  "businessId": "optional-source-id",
  "scene": {
    "entryDurationMs": 1200,
    "commands": [
      {
        "offsetMs": 0,
        "elements": [
          {
            "id": "icon",
            "type": "animation",
            "assetHash": "SHA256",
            "loop": true
          }
        ]
      },
      {
        "offsetMs": 1200,
        "elements": [
          { "id": "label", "type": "text", "text": "Hello", "font": "small" }
        ]
      }
    ]
  }
}
```

`kind` is `event|condition|agent`; `level` is `urgent|attention|info`. `version` monotonically increases; equal version retransmission is idempotent and cannot change body. Identity is JSON `[serviceId,instanceId,itemId]`, exposed as `itemKey`. Scene accepts optional `ledColor` as `#RRGGBBAA`. Scene is complete recoverable entrance, <=32 ordered commands, offsets 0..10000ms, <=64 elements total; at least one offset0 command. All element IDs are namespace-local. Asset references use `assetHash` replacing native `path`; producer-supplied native paths/stock paths/timeout/display_until/application_name are rejected. Allowed native elements: text/image/animation/countdown/rectangle/xpmbitmap, plus documented rendering properties. Assets and text bounded. Producer title/detail max 256/2048 chars, total body max 128KiB, per-device 256 live items/2MiB presentation JSON. firstRecognizedAt is immutable, accepted within 5m backend receive time; otherwise receive time is used and timeReliable=false. validity maximum 24h; heartbeats renew only source liveness, never visible duration or completed occurrence. Items cannot outlive their epoch, heartbeat timeout or validity.

`POST /api/heartbeat {instanceId,epoch,itemIds:[...],validUntil}` refreshes matching existing items only, returns snapshot + item results (including tombstones); never creates/revives. `POST /api/end {instanceId,epoch,itemId,version}` ends matching occurrence with monotonic version tombstone. Version and epoch checks reject late traffic even after body cleanup. Tombstones contain identity/version/epoch/reason only, expire with epoch; capacity rejects new work rather than evicting replay protection. New occurrence needs new itemId.

`POST /api/update {instanceId,epoch,itemId,version,generation,elements:[...],scene?:Scene}` applies native motion/content update only to the current selected matching generation. When supplied, the validated complete `scene` replaces recovery state verbatim; `elements` remains only the immediate native draw delta and is not merged into that scene. This lets transient outgoing fade masks and numeric rolls stay out of restored scenes. Without `scene`, matching elements are merged into recovery as before. Both delta and recovery asset references require service ownership. Exact same-version retries bind both delta and optional recovery scene; conflicting retries return409. ACKed native values are persisted separately from recovery, and diffing projects pending generation-bound clear/draw intents over them. Opaque-to-clear mask deltas and same-owner full-publish corrections therefore reach the device without resending unchanged scrolling text. Native metadata is bounded to128live element IDs/1MiB and expires with actual native TTL; acknowledged transient asset hashes keep their device slots pinned through that TTL, independently of recovery membership. Native animation updates preserve IDs and playback; omitted or unchanged text is not resent. Equal-version same-content update retries are idempotent. Element type transitions delete only owned element IDs before replacement. The acknowledged current representative content version advances its frozen admission; unacknowledged later content at finite expiry reenters once with zero remaining lifetime, then completes after entry, without resetting the original visible budget. New group member identities remain excluded from an older admission. A full same-item version publish replaces recovery scene, changes current elements without restarting entrance; scheduler preemption/resume creates a new generation and replays complete entrance using latest scene.

`POST /api/assets {hash,type:'png'|'gif'|'webp'|'anim',data:'base64'}` content hash verified. <=256KiB per asset, 4MiB/64 files cloud cache per device; bounded global device slots 16/2MiB. Unreferenced cache entries are LRU reclaimed; live scenes and pending commands pin cloud hashes, playing/pending command references pin device slots. Capacity failures are explicit. Uploaded assets are service-owned; hashes may be shared by repeated upload, never exposed in snapshots. Unused cloud content expires after1h. Occupied device slot extensions are immutable; only same-type slots may be reused, preventing stale alternate-extension files from growing the device file count. Device filename is backend assigned `slot-N.ext` in `busy-control` namespace. No direct storage paths accepted.

## Snapshots and UI

`GET /api/snapshot`, `GET /api/events` (SSE `event: snapshot`, data full JSON) return current full state, no Last-Event-ID replay. SSE expires/reconnects after 55s; max16 connections and slow consumers closed. All state events use same snapshot revision. Producer must reconnect with Bearer fetch streaming (EventSource cannot set header).

Snapshot fields: `{protocol:1,deviceId,revision,configRevision,generation,health:{status:'unknown'|'healthy'|'blocked'|'offline',confirmedValidUntil,lastSuccessAt},selected:itemKey|null,applying:itemKey|null,displaying:{itemKey,generation,confirmedAt,confirmedValidUntil}|null,services:[{id,name,template,config,epoch,epochExpiresAt}],items:[{itemKey,serviceId,instanceId,itemId,version,kind,level,groupKey,title,detail,firstRecognizedAt,timeReliable,receivedAt,enqueueSeq,state:'waiting'|'applying'|'displaying'|'preempted'|'paused'|'snoozed',remainingMs,nextEligibleAt,eta:{kind:'estimate'|'await-resolution'|'paused'|'snoozed'|'unknown',at?:number},queueProof?:{revision,itemKey,controller:{itemKey,generation},validUntil}}],groups:[{groupId,representative,memberKeys,level,order}],actions:[{id,requestId,itemKey,serviceId,instanceId,itemId,generation,actionKey,businessId,status:'pending'|'running'|'succeeded'|'failed'|'unknown',createdAt,expiresAt}],tombstones:[{itemKey,version,reason}]}`.

Producer sees own service, items, groups, actions and tombstones only. Other-owner confirmation metadata includes opaque itemKey/generation/validity; no other service title/detail/scene/business ID/credential. Items also expose own `actionKeys`, `actionAvailable`, `validUntil`, `lastHeartbeat` and `source:{connected,lastHeartbeat}` to admin/authorized publisher. Frozen admitted group item IDs/versions receive `coverageProof:{revision,itemKey,version,controller:{itemKey,generation},validUntil}` bounded by the actual matching device confirmation. A late unadmitted urgent group member gets waiting queueProof instead of a display claim. queueProof is emitted only while waiting on another confirmed healthy urgent item, bounded by actual device confirmation. Repeated snapshots/heartbeat do not extend confirmation. `displaying` means successful API acknowledgment, not pixel readback.

`POST /api/items` (admin) `{itemKey,operation:'pause'|'resume'|'end',expectedRevision}` uses current snapshot revision. `POST /api/actions {requestId,itemKey,generation,actionKey}` (admin or owning publisher with instanceId) creates durable action. Only advertised action keys accepted, online source required; expires30s. Producer `POST /api/actions/:id/result {instanceId,status:'running'|'succeeded'|'failed'|'unknown'}`. Repeated result idempotent; terminal transitions reject conflicting result. Timed-out actions become unknown; authoritative late succeeded/failed may resolve unknown, but expired pending actions cannot begin running. Pending actions reappear in every full snapshot; local executor must persist action ID before invoking external side effect. Only succeeded ends original exact item version; stale success never ends newer version/generation or other items. Unknown/failed retain item. Never automatically retry side effects.

`POST /api/input {eventId,instanceId,generation,button:'start_pause'}` (admin or a publisher explicitly granted `config.allowInput:true`; ordinary publishers are rejected) checks current generation, dedupes event ID. Urgent primary creates action; otherwise atomically tombstones all currently existing nonurgent items (including paused/snoozed) with revision boundary. Urgent survives; same IDs never reappear. 409 stale generation does nothing.

## Operational bounds

Commands are durable before HTTP. One sequential dispatcher per device checks generation before each next write, fixed 8s HTTP timeout, no redirected requests. DO alarm retries failed commands with bounded backoff, deducts elapsed visible time and recovers uncertain in-flight state by clearing platform namespace and replaying current complete scene. Acknowledged commands are not resent on heartbeat/restart. Finite visible time starts after all entrance writes acknowledge and entry delay completes; preemption pauses it. Conditions default10s visible then30m snooze; urgent defaults source exit. Each acknowledged element retains its conservative send-time TTL expiry. Text and widgets renew independently15s before their earliest actual expiry only when the intended visible end still needs them; short finite text is sent once with remaining+entry+margin TTL (max60s), even when entry delays the final acknowledgment. Steady renewal and same-item full-publish replacements use serialized batches of at most32elements per BUSY draw. Only acknowledgment of every chunk refreshes confirmation, bounded by the earliest current element expiry; a stale successful prefix after a failed/late suffix cannot establish a proof, and the next alarm reconstructs a complete fresh bounded renewal. Browser close does not stop alarms. No production device writes/deployment are part of automated tests.
