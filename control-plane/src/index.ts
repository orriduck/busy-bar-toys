import { StateStore } from "./store";
import { PreviewRelay } from "./preview";
import { DurableObject } from "cloudflare:workers";
import {
  Action,
  Command,
  Element,
  Item,
  ProtocolError,
  State,
  acceptDisplay,
  actionResult,
  createState,
  enqueue,
  finishItem,
  heartbeat,
  identifier,
  input,
  integer,
  patchConfig,
  pauseItem,
  publish,
  record,
  registerService,
  requestAction,
  requireThat,
  snapshot,
  text,
  tick,
  validateElements,
  validateScene,
} from "./model";
import { BusyClient, NAMESPACE, NATIVE_PRIORITY } from "./busy";
import { storeAsset, pinnedSlots, reserveSlots } from "./assets";
import {
  base64,
  decrypt,
  digest,
  encrypt,
  jsonBody,
  signSession,
  unbase64,
  verifySession,
} from "./security";
export interface RuntimeEnv extends Env {
  BUSY_UPSTREAM?: Fetcher;
}
type Auth =
  | { kind: "session"; id: string; expiresAt: number }
  | { kind: "publisher"; serviceId: string; hash: string };
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { ...headers, ...extra } });
}
function safeError(error: unknown) {
  return error instanceof ProtocolError
    ? json({ error: error.code }, error.status)
    : json({ error: "INTERNAL_ERROR" }, 500);
}
function hashesEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let j = 0; j < a.length; j++) diff |= a.charCodeAt(j) ^ b.charCodeAt(j);
  return diff === 0;
}

export class DeviceControl extends DurableObject<RuntimeEnv> {
  private store: StateStore;
  private preview = new PreviewRelay();
  private dispatching = false;
  private lastBroadcastRevision: number | null = null;
  private streams = new Map<
    string,
    {
      auth: Auth;
      controller: ReadableStreamDefaultController<Uint8Array>;
      timer: ReturnType<typeof setTimeout>;
      heartbeat: ReturnType<typeof setInterval>;
    }
  >();
  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env);
    this.store = new StateStore(ctx.storage);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL)",
    );
    const s = this.load();
    if (s) this.preview.update(s);
    if (s && s.commands.some((c) => c.status === "inflight")) {
      tick(s, Date.now());
      const item = s.selected ? s.items[s.selected] : null;
      s.commands = [];
      s.generation++;
      s.displaying = null;
      s.applying = s.selected;
      s.visibleSince = null;
      s.entryAt = null;
      s.elementExpiries = {};
      s.nativeElements = {};
      enqueue(s, {
        generation: s.generation,
        kind: "clear",
        dueAt: Date.now(),
      });
      if (item)
        for (const c of item.scene.commands)
          enqueue(s, {
            generation: s.generation,
            kind: "draw",
            dueAt: Date.now() + c.offsetMs,
            elements: c.elements,
          });
      s.revision++;
      this.save(s);
    }
  }
  private load(): State | null {
    return this.store.load();
  }
  private save(s: State) {
    this.ctx.storage.transactionSync(() => {
      this.store.save(s);
      this.ctx.storage.sql.exec(
        "INSERT INTO audit(at,revision,generation,status) VALUES(?,?,?,?)",
        Date.now(),
        s.revision,
        s.generation,
        s.health.status,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM audit WHERE at<? OR id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 1024)",
        Date.now() - 7 * 86400000,
      );
    });
    this.preview.update(s);
    if (this.lastBroadcastRevision !== s.revision) {
      this.lastBroadcastRevision = s.revision;
      this.broadcast(s);
    }
  }
  private authorize(s: State, auth: Auth) {
    const now = Date.now();
    if (auth.kind === "session") {
      requireThat(
        auth.expiresAt > now && s.sessions[auth.id] > now,
        "UNAUTHORIZED",
        401,
      );
      return undefined;
    }
    const service = s.services[auth.serviceId];
    requireThat(
      service &&
        service.epochExpiresAt > now &&
        hashesEqual(service.credentialHash, auth.hash),
      "UNAUTHORIZED",
      401,
    );
    return service.id;
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      requireThat(
        url.origin === "https://device.internal" &&
          request.method === "GET" &&
          !url.search,
        "FORBIDDEN",
        403,
      );
      const raw = request.headers.get("X-Busy-Internal-Auth");
      requireThat(raw, "FORBIDDEN", 403);
      const auth = JSON.parse(raw) as Auth;
      requireThat(
        auth && (auth.kind === "session" || auth.kind === "publisher"),
        "FORBIDDEN",
        403,
      );
      const s = this.load();
      requireThat(s, "UNAUTHORIZED", 401);
      this.authorize(s, auth);
      this.preview.update(s);
      if (url.pathname === "/api/preview/publish") {
        requireThat(auth.kind === "publisher", "FORBIDDEN", 403);
        requireThat(
          request.headers.get("Upgrade")?.toLowerCase() === "websocket",
          "WEBSOCKET_REQUIRED",
          426,
        );
        return this.preview.openPublisher(
          auth,
          request.headers.get("X-Busy-Instance"),
          request.headers.get("X-Busy-Epoch"),
        );
      }
      requireThat(auth.kind === "session", "FORBIDDEN", 403);
      if (url.pathname === "/api/preview/status")
        return json(this.preview.status());
      const match = /^\/api\/preview\/frames\/([a-f0-9]{64})$/.exec(
        url.pathname,
      );
      requireThat(match, "NOT_FOUND", 404);
      return this.preview.openViewer(auth, match[1], request.signal);
    } catch (error) {
      return safeError(error);
    }
  }
  async login(
    deviceId: string,
    tokenCipher: string,
    id: string,
    expiresAt: number,
  ) {
    const s = this.load() ?? createState(deviceId);
    requireThat(s.deviceId === deviceId, "DEVICE_MISMATCH", 409);
    tick(s, Date.now());
    requireThat(Object.keys(s.sessions).length < 64, "SESSION_CAPACITY", 413);
    s.tokenCipher = tokenCipher;
    s.sessions[id] = expiresAt;
    s.revision++;
    this.save(s);
    await this.arm();
    return { deviceId };
  }
  async handle(
    auth: Auth,
    path: string,
    method: string,
    body: Record<string, unknown> = {},
  ): Promise<Response> {
    try {
      // Perform cryptography before reading the mutable state; no external I/O is held under a storage gate.
      let newSecret: string | undefined, newHash: string | undefined;
      const updateFingerprint =
        path === "/api/update" && method === "POST"
          ? await digest(
              JSON.stringify({
                elements: body.elements,
                scene: body.scene ?? null,
              }),
            )
          : undefined;
      if (
        method === "POST" &&
        (path === "/api/services" ||
          /^\/api\/services\/[\w-]+\/credential$/.test(path))
      ) {
        requireThat(auth.kind === "session", "FORBIDDEN", 403);
        newSecret = base64(crypto.getRandomValues(new Uint8Array(32)))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "");
        newHash = await digest(newSecret);
      }
      if (path === "/api/assets" && method === "POST") {
        requireThat(typeof body.data === "string", "INVALID_ASSET");
        let bytes: Uint8Array;
        try {
          bytes = unbase64(body.data);
        } catch {
          throw new ProtocolError("INVALID_ASSET");
        }
        requireThat(bytes.length <= 262144, "ASSET_SIZE", 413);
        requireThat((await digest(bytes)) === body.hash, "ASSET_HASH_MISMATCH");
      }
      const s = this.load();
      requireThat(s, "UNAUTHORIZED", 401);
      const serviceId = this.authorize(s, auth),
        now = Date.now();
      if (path === "/api/preview/viewer" && method === "POST") {
        this.preview.update(s);
        return json(
          this.preview.viewer(auth, identifier(body.viewerId), body.operation),
        );
      }
      tick(s, now);
      const admin = () =>
        requireThat(auth.kind === "session", "FORBIDDEN", 403);
      const producer = () => {
        requireThat(serviceId, "PUBLISHER_REQUIRED", 403);
        return serviceId;
      };
      const sourceItem = (key: string) => {
        const item = s.items[key];
        requireThat(item, "ITEM_NOT_FOUND", 404);
        if (serviceId)
          requireThat(
            item.serviceId === serviceId && body.instanceId === item.instanceId,
            "FORBIDDEN",
            403,
          );
        return item;
      };
      let response: Response | undefined;
      if (path === "/api/session" && method === "GET") {
        admin();
        response = json({
          deviceId: s.deviceId,
          demo: !!this.env.BUSY_UPSTREAM,
        });
      } else if (path === "/api/session" && method === "DELETE") {
        admin();
        if (auth.kind === "session") delete s.sessions[auth.id];
        response = json({ ok: true }, 200, {
          "Set-Cookie":
            "busy_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
        });
      } else if (path === "/api/snapshot" && method === "GET")
        response = json({
          ...snapshot(s, now, serviceId),
          demo: !!this.env.BUSY_UPSTREAM,
        });
      else if (path === "/api/events" && method === "GET") {
        this.save(s);
        await this.arm();
        return this.openStream(s, auth);
      } else if (path === "/api/services" && method === "POST") {
        admin();
        requireThat(
          body.expectedRevision === s.configRevision,
          "CONFIG_CONFLICT",
          409,
        );
        const svc = registerService(
          s,
          body,
          newHash!,
          crypto.randomUUID(),
          now,
        );
        response = json(
          {
            credential: `${s.deviceId}.${svc.id}.${newSecret}`,
            epoch: svc.epoch,
            epochExpiresAt: svc.epochExpiresAt,
            snapshot: snapshot(s, now),
          },
          201,
        );
      } else if (/^\/api\/services\/[\w-]+$/.test(path) && method === "PATCH") {
        admin();
        patchConfig(
          s,
          path.split("/")[3],
          body.config,
          Number(body.expectedRevision),
          now,
        );
        response = json({ snapshot: snapshot(s, now) });
      } else if (
        /^\/api\/services\/[\w-]+\/(revoke|credential)$/.test(path) &&
        method === "POST"
      ) {
        admin();
        requireThat(
          body.expectedRevision === s.configRevision,
          "CONFIG_CONFLICT",
          409,
        );
        const id = path.split("/")[3],
          svc = s.services[id];
        requireThat(svc, "SERVICE_NOT_FOUND", 404);
        for (const i of Object.values(s.items))
          if (i.serviceId === id)
            finishItem(s, i.itemKey, "revoked", i.version, now);
        svc.credentialHash = newHash ?? "";
        svc.epoch = crypto.randomUUID();
        svc.epochExpiresAt = now + 30 * 86400000;
        s.configRevision++;
        s.revision++;
        response = json({
          ...(newSecret
            ? {
                credential: `${s.deviceId}.${id}.${newSecret}`,
                epoch: svc.epoch,
                epochExpiresAt: svc.epochExpiresAt,
              }
            : {}),
          snapshot: snapshot(s, now),
        });
      } else if (path === "/api/publish" && method === "POST") {
        const id = producer();
        const scene = record(body.scene);
        requireThat(Array.isArray(scene.commands));
        for (const raw of scene.commands) {
          const command = record(raw);
          requireThat(Array.isArray(command.elements));
          for (const rawElement of command.elements) {
            const element = record(rawElement);
            if (element.assetHash)
              requireThat(
                s.assets[String(element.assetHash)]?.owners.includes(id),
                "ASSET_NOT_AUTHORIZED",
                403,
              );
          }
        }
        const old = s.items[JSON.stringify([id, body.instanceId, body.itemId])];
        const previousVersion = old?.version;
        const item = publish(s, id, body, now);
        if (
          previousVersion !== undefined &&
          item.version > previousVersion &&
          s.selected === item.itemKey
        ) {
          const oldElements = this.projectedNativeElements(s);
          const newElements = new Map<string, Element>();
          for (const c of item.scene.commands)
            for (const e of c.elements) newElements.set(e.id, e);
          const changed = [...newElements.values()].filter(
            (e) => JSON.stringify(e) !== JSON.stringify(oldElements.get(e.id)),
          );
          const removed = [...oldElements.keys()].filter(
            (id) => !newElements.has(id),
          );
          const transitioned = changed
            .filter(
              (e) =>
                oldElements.has(e.id) && oldElements.get(e.id)!.type !== e.type,
            )
            .map((e) => e.id);
          const replacementBatch = s.commandSeq + 1;
          if (removed.length || transitioned.length)
            enqueue(s, {
              generation: s.generation,
              kind: "clear",
              dueAt: now,
              elementIds: [...removed, ...transitioned],
              refresh: true,
              itemKey: item.itemKey,
              itemVersion: item.version,
              refreshBatch: replacementBatch,
            });
          if (changed.length)
            this.queueRefresh(s, changed, now, {
              itemKey: item.itemKey,
              itemVersion: item.version,
              refreshBatch: replacementBatch,
            });
          else this.bindContentAcknowledgement(s, item);
        }
        response = json({
          itemKey: item.itemKey,
          snapshot: snapshot(s, now, id),
        });
      } else if (path === "/api/heartbeat" && method === "POST") {
        const id = producer();
        const results = heartbeat(s, id, body, now);
        response = json({ results, snapshot: snapshot(s, now, id) });
      } else if (path === "/api/end" && method === "POST") {
        const id = producer();
        requireThat(body.epoch === s.services[id].epoch, "EPOCH_EXPIRED", 409);
        const key = JSON.stringify([
          id,
          identifier(body.instanceId),
          identifier(body.itemId),
        ]);
        if (!s.items[key] && !s.tombstones[key]) {
          requireThat(
            Object.keys(s.tombstones).length + Object.keys(s.items).length <
              4096,
            "TOMBSTONE_CAPACITY",
            413,
          );
          s.tombstones[key] = {
            itemKey: key,
            serviceId: id,
            epoch: s.services[id].epoch,
            expiresAt: s.services[id].epochExpiresAt,
            version: integer(body.version, 1, Number.MAX_SAFE_INTEGER),
            reason: "resolved",
          };
          s.revision++;
        }
        finishItem(
          s,
          key,
          "resolved",
          integer(body.version, 1, Number.MAX_SAFE_INTEGER),
          now,
        );
        response = json({ snapshot: snapshot(s, now, id) });
      } else if (path === "/api/assets" && method === "POST") {
        const id = producer();
        storeAsset(s, id, body, now);
        response = json({ hash: body.hash });
      } else if (path === "/api/update" && method === "POST") {
        const id = producer();
        requireThat(body.epoch === s.services[id].epoch, "EPOCH_EXPIRED", 409);
        const key = JSON.stringify([
            id,
            identifier(body.instanceId),
            identifier(body.itemId),
          ]),
          item = sourceItem(key);
        requireThat(
          s.selected === key && body.generation === s.generation,
          "STALE_TARGET",
          409,
        );
        const version = integer(
            body.version,
            item.version,
            Number.MAX_SAFE_INTEGER,
          ),
          elements = validateElements(body.elements);
        const recoveryScene =
          body.scene === undefined ? undefined : validateScene(body.scene);
        const latest = this.projectedNativeElements(s);
        const changed = elements.filter(
          (e) => JSON.stringify(e) !== JSON.stringify(latest.get(e.id)),
        );
        requireThat(
          version !== item.version ||
            (item.lastUpdateFingerprint
              ? item.lastUpdateFingerprint === updateFingerprint
              : changed.length === 0 &&
                (!recoveryScene ||
                  JSON.stringify(recoveryScene) ===
                    JSON.stringify(item.scene))),
          "STALE_VERSION",
          409,
        );
        if (version === item.version)
          return json({ snapshot: snapshot(s, now, id) });
        for (const e of [
          ...elements,
          ...(recoveryScene?.commands.flatMap((command) => command.elements) ??
            []),
        ])
          if (e.assetHash)
            requireThat(
              s.assets[e.assetHash]?.owners.includes(id),
              "ASSET_NOT_AUTHORIZED",
              403,
            );
        const transitioned = elements
          .filter((e) => latest.has(e.id) && latest.get(e.id)!.type !== e.type)
          .map((e) => e.id);
        if (transitioned.length)
          enqueue(s, {
            generation: s.generation,
            kind: "clear",
            dueAt: now,
            elementIds: [...new Set(transitioned)],
            refresh: true,
          });
        if (recoveryScene) item.scene = recoveryScene;
        else {
          for (const e of elements) {
            let replaced = false;
            for (const c of item.scene.commands) {
              const index = c.elements.findIndex((old) => old.id === e.id);
              if (index >= 0) {
                c.elements[index] = e;
                replaced = true;
              }
            }
            if (!replaced)
              item.scene.commands[item.scene.commands.length - 1].elements.push(
                e,
              );
          }
        }
        requireThat(
          JSON.stringify(item.scene).length <= 32768,
          "SCENE_CAPACITY",
          413,
        );
        item.scene = validateScene(item.scene);
        item.version = version;
        item.lastUpdateFingerprint = updateFingerprint;
        if (changed.length)
          this.queueRefresh(s, changed, now, {
            itemKey: item.itemKey,
            itemVersion: version,
          });
        else this.bindContentAcknowledgement(s, item);
        s.revision++;
        response = json({ snapshot: snapshot(s, now, id) });
      } else if (path === "/api/items" && method === "POST") {
        admin();
        requireThat(
          body.expectedRevision === s.revision,
          "STATE_CONFLICT",
          409,
        );
        pauseItem(s, text(body.itemKey, 512), String(body.operation), now);
        response = json({ snapshot: snapshot(s, now) });
      } else if (path === "/api/actions" && method === "POST") {
        sourceItem(text(body.itemKey, 512));
        const action = requestAction(
          s,
          {
            requestId: identifier(body.requestId),
            itemKey: String(body.itemKey),
            generation: integer(body.generation, 0, Number.MAX_SAFE_INTEGER),
            actionKey: identifier(body.actionKey),
          },
          now,
        );
        response = json({ action, snapshot: snapshot(s, now, serviceId) });
      } else if (
        /^\/api\/actions\/[\w-]+\/result$/.test(path) &&
        method === "POST"
      ) {
        const id = producer(),
          action = s.actions[path.split("/")[3]];
        requireThat(
          action &&
            action.serviceId === id &&
            action.instanceId === body.instanceId,
          "FORBIDDEN",
          403,
        );
        actionResult(s, action.id, body.status as Action["status"], now);
        response = json({ snapshot: snapshot(s, now, id) });
      } else if (path === "/api/input" && method === "POST") {
        if (serviceId)
          requireThat(
            s.services[serviceId].config.allowInput,
            "INPUT_CAPABILITY_REQUIRED",
            403,
          );
        identifier(body.instanceId);
        requireThat(body.button === "start_pause");
        const result = input(
          s,
          identifier(body.eventId),
          integer(body.generation, 0, Number.MAX_SAFE_INTEGER),
          now,
        );
        response = json({ ...result, snapshot: snapshot(s, now, serviceId) });
      } else throw new ProtocolError("NOT_FOUND", 404);
      requireThat(
        new TextEncoder().encode(JSON.stringify(s.items)).length <=
          2 * 1024 * 1024,
        "ITEM_CAPACITY",
        413,
      );
      requireThat(
        s.commands.length <= 256 &&
          new TextEncoder().encode(JSON.stringify(s.commands)).length <=
            2 * 1024 * 1024,
        "COMMAND_CAPACITY",
        413,
      );
      this.save(s);
      await this.arm();
      this.ctx.waitUntil(this.dispatch());
      return response;
    } catch (error) {
      return safeError(error);
    }
  }
  private openStream(s: State, auth: Auth) {
    requireThat(this.streams.size < 16, "SSE_CAPACITY", 429);
    const id = crypto.randomUUID();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const timer = setTimeout(
          () => this.closeStream(id),
          Math.min(
            55000,
            auth.kind === "session" ? auth.expiresAt - Date.now() : 55000,
          ),
        );
        const heartbeat = setInterval(() => {
          try {
            const current = this.load();
            requireThat(current, "UNAUTHORIZED", 401);
            this.authorize(current, auth);
            requireThat((controller.desiredSize ?? 0) > 0, "SLOW_CONSUMER");
            // Keep the producer's five-second socket read alive without
            // inventing a revision or repeating its full snapshot.
            controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
          } catch {
            this.closeStream(id);
          }
        }, 2000);
        this.streams.set(id, { auth, controller, timer, heartbeat });
        controller.enqueue(this.frame(s, auth));
      },
      cancel: () => this.closeStream(id),
    });
    return new Response(stream, {
      headers: {
        ...headers,
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      },
    });
  }
  private closeStream(id: string) {
    const entry = this.streams.get(id);
    if (!entry) return;
    this.streams.delete(id);
    clearTimeout(entry.timer);
    clearInterval(entry.heartbeat);
    try {
      entry.controller.close();
    } catch {}
  }
  private frame(s: State, auth: Auth) {
    const serviceId = this.authorize(s, auth);
    return new TextEncoder().encode(
      "event: snapshot\nid: " +
        s.revision +
        "\ndata: " +
        JSON.stringify({
          ...snapshot(s, Date.now(), serviceId),
          demo: !!this.env.BUSY_UPSTREAM,
        }) +
        "\n\n",
    );
  }
  private broadcast(s: State) {
    for (const [id, entry] of this.streams) {
      try {
        requireThat((entry.controller.desiredSize ?? 0) > 0, "SLOW_CONSUMER");
        entry.controller.enqueue(this.frame(s, entry.auth));
      } catch {
        this.closeStream(id);
      }
    }
  }
  private async arm() {
    const s = this.load();
    if (!s) return;
    const now = Date.now(),
      deadlines: number[] = [];
    for (const i of Object.values(s.items)) {
      deadlines.push(
        i.validUntil,
        i.lastHeartbeat + s.services[i.serviceId].config.heartbeatMs,
        s.services[i.serviceId].epochExpiresAt,
      );
      if (i.nextEligibleAt) deadlines.push(i.nextEligibleAt);
    }
    const current = s.selected ? s.items[s.selected] : null;
    if (current && current.remainingMs !== null && s.visibleSince !== null)
      deadlines.push(Math.max(now, s.visibleSince) + current.remainingMs);
    const firstCommand = s.commands[0];
    if (firstCommand)
      deadlines.push(
        firstCommand.status === "inflight"
          ? (firstCommand.startedAt ?? now) + 9000
          : firstCommand.dueAt,
      );
    if (s.nextTextAt) deadlines.push(s.nextTextAt);
    if (s.nextWidgetAt) deadlines.push(s.nextWidgetAt);
    for (const t of Object.values(s.tombstones)) deadlines.push(t.expiresAt);
    for (const expiry of Object.values(s.sessions)) deadlines.push(expiry);
    for (const asset of Object.values(s.assets))
      if (asset.usedAt + 3600000 > now) deadlines.push(asset.usedAt + 3600000);
    for (const input of Object.values(s.inputs))
      deadlines.push(input.expiresAt);
    for (const a of Object.values(s.actions))
      deadlines.push(a.createdAt + 86400000);
    for (const a of Object.values(s.actions))
      if (a.status === "pending" || a.status === "running")
        deadlines.push(a.expiresAt);
    if (s.displaying && s.displaying.confirmedValidUntil > now)
      deadlines.push(s.displaying.confirmedValidUntil);
    if (deadlines.length)
      await this.ctx.storage.setAlarm(
        Math.max(now + 50, Math.min(...deadlines)),
      );
    else await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    const s = this.load();
    if (!s) return;
    const now = Date.now();
    if (
      s.displaying &&
      s.displaying.confirmedValidUntil <= now &&
      s.visibleSince !== null
    ) {
      tick(s, Math.max(s.visibleSince, s.displaying.confirmedValidUntil));
      s.visibleSince = null;
    }
    tick(s, now);
    if (
      s.displaying &&
      s.displaying.confirmedValidUntil <= now &&
      s.health.status === "healthy"
    ) {
      s.health.status = "offline";
      s.revision++;
    }
    this.refresh(s, now);
    this.save(s);
    await this.dispatch();
    await this.arm();
  }
  private bindContentAcknowledgement(s: State, item: Item) {
    const pending = s.commands.filter(
      (command) =>
        command.generation === s.generation &&
        (command.kind === "draw" || command.kind === "clear"),
    );
    if (pending.length) {
      const batch = ++s.commandSeq;
      for (const command of pending) {
        command.itemKey = item.itemKey;
        command.itemVersion = item.version;
        command.refreshBatch = batch;
      }
    } else if (s.displaying?.itemKey === item.itemKey) {
      const admission = s.admission.find((a) => a.itemKey === item.itemKey);
      if (admission) admission.version = item.version;
    }
  }
  private acknowledgeNativeContent(
    live: State,
    cmd: Command,
    acceptedAt: number,
  ) {
    if (
      cmd.itemKey === live.selected &&
      cmd.itemVersion &&
      live.items[cmd.itemKey]?.version === cmd.itemVersion &&
      !live.commands.some(
        (c) => c.itemKey === cmd.itemKey && c.itemVersion === cmd.itemVersion,
      )
    ) {
      const admission = live.admission.find((a) => a.itemKey === cmd.itemKey);
      if (admission) admission.version = cmd.itemVersion;
    }
    const futureEntrance = live.commands.some(
      (c) =>
        c.generation === live.generation && !c.refresh && c.kind === "draw",
    );
    const batchComplete =
      cmd.refreshBatch === undefined ||
      !live.commands.some(
        (c) =>
          c.generation === live.generation &&
          c.refreshBatch === cmd.refreshBatch,
      );
    if (!futureEntrance && batchComplete && live.selected) {
      const item = live.items[live.selected];
      const validUntil = Math.min(
        ...this.latestElements(item).map(
          (e) => live.elementExpiries[e.id]?.expiresAt ?? 0,
        ),
      );
      if (validUntil > acceptedAt) {
        if (live.applying || live.visibleSince === null)
          acceptDisplay(live, live.generation, acceptedAt);
        else if (cmd.refresh) live.revision++;
        live.health = {
          status: "healthy",
          confirmedValidUntil: validUntil,
          lastSuccessAt: acceptedAt,
        };
        live.displaying = {
          itemKey: live.selected,
          generation: live.generation,
          confirmedAt: acceptedAt,
          confirmedValidUntil: validUntil,
        };
      } else {
        // A slow or failed suffix can outlive a successful prefix. Only
        // a new complete renewal can establish another finite proof.
        live.health.status = "offline";
        live.health.confirmedValidUntil = 0;
        live.displaying = null;
        live.applying = null;
        live.visibleSince = null;
        live.revision++;
      }
    }
    this.renewalDeadlines(live, acceptedAt);
  }
  private projectedNativeElements(s: State): Map<string, Element> {
    const elements = new Map(Object.entries(s.nativeElements));
    for (const command of s.commands) {
      if (command.generation !== s.generation) continue;
      if (command.kind === "clear") {
        if (command.elementIds)
          for (const id of command.elementIds) elements.delete(id);
        else elements.clear();
      } else if (command.kind === "draw")
        for (const element of command.elements ?? [])
          elements.set(element.id, element);
    }
    return elements;
  }
  private queueRefresh(
    s: State,
    elements: Element[],
    now: number,
    metadata: Pick<Command, "itemKey" | "itemVersion" | "refreshBatch"> = {},
  ) {
    const projected = this.projectedNativeElements(s);
    for (const element of elements) projected.set(element.id, element);
    requireThat(
      projected.size <= 128 &&
        new TextEncoder().encode(JSON.stringify([...projected.values()]))
          .length <=
          1024 * 1024,
      "NATIVE_ELEMENT_CAPACITY",
      413,
    );
    const batch = metadata.refreshBatch ?? s.commandSeq + 1;
    for (let offset = 0; offset < elements.length; offset += 32)
      enqueue(s, {
        generation: s.generation,
        kind: "draw",
        dueAt: now,
        elements: elements.slice(offset, offset + 32),
        refresh: true,
        ...metadata,
        refreshBatch: batch,
      });
  }
  private latestElements(item: Item): Element[] {
    const latest = new Map<string, Element>();
    for (const command of item.scene.commands)
      for (const element of command.elements) latest.set(element.id, element);
    return [...latest.values()];
  }
  private renewalDeadlines(s: State, now: number) {
    const item = s.selected ? s.items[s.selected] : null;
    if (!item) {
      s.nextTextAt = null;
      s.nextWidgetAt = null;
      return;
    }
    const intendedEnd =
      item.remainingMs === null
        ? Infinity
        : Math.max(
            now,
            s.visibleSince ?? s.entryAt ?? now + item.scene.entryDurationMs,
          ) + item.remainingMs;
    const deadline = (type: "text" | "widgets") => {
      const values = this.latestElements(item)
        .filter((e) =>
          type === "text" ? e.type === "text" : e.type !== "text",
        )
        .flatMap((e) => {
          const expiry = s.elementExpiries[e.id]?.expiresAt;
          if (expiry === undefined) return [now];
          return expiry < intendedEnd + 1000 ? [expiry - 15000] : [];
        });
      return values.length ? Math.min(...values) : null;
    };
    s.nextTextAt = deadline("text");
    s.nextWidgetAt = deadline("widgets");
  }
  private refresh(s: State, now: number) {
    if (!s.selected || s.applying) return;
    const item = s.items[s.selected];
    if (!item) return;
    this.renewalDeadlines(s, now);
    const latest = this.latestElements(item);
    const batch = s.commandSeq + 1;
    const renew = (type: "text" | "widgets", due: number | null) => {
      const matches = (e: Element) =>
        type === "text" ? e.type === "text" : e.type !== "text";
      if (
        due === null ||
        due > now ||
        s.commands.some((c) => c.refresh && c.elements?.some(matches))
      )
        return;
      const elements = latest.filter(matches);
      this.queueRefresh(s, elements, now, { refreshBatch: batch });
    };
    renew("text", s.nextTextAt);
    renew("widgets", s.nextWidgetAt);
  }
  private async dispatch() {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      for (let count = 0; count < 128; count++) {
        const s = this.load();
        if (!s?.tokenCipher) break;
        const now = Date.now();
        tick(s, now);
        s.commands = s.commands.filter(
          (c) => c.generation === s.generation || c.status === "inflight",
        );
        const cmd = s.commands[0];
        if (!cmd || cmd.dueAt > now) {
          this.save(s);
          break;
        }
        // Reserve all assets for the generation before any draw. Playing/pending slots stay pinned.
        if (cmd.kind === "draw") {
          const hashes = (cmd.elements ?? []).flatMap((e) =>
            e.assetHash ? [e.assetHash] : [],
          );
          const slots = reserveSlots(s, hashes, pinnedSlots(s), now);
          const pending = slots.filter((slot) => !slot.uploaded);
          if (pending.length) {
            for (const slot of pending.reverse())
              s.commands.unshift({
                id: ++s.commandSeq,
                generation: s.generation,
                kind: "upload",
                dueAt: now,
                hash: slot.hash,
                slot: slot.slot,
                status: "pending",
                attempts: 0,
              });
            this.save(s);
            continue;
          }
        }
        cmd.status = "inflight";
        cmd.startedAt = now;
        cmd.attempts++;
        this.save(s);
        await this.arm();
        let failed: unknown = null;
        let drawExpiresAt: number | undefined;
        let drawSentAt: number | undefined;
        try {
          const token = await decrypt(
            s.tokenCipher,
            this.env.TOKEN_ENCRYPTION_KEY,
          );
          const beforeWrite = this.load();
          if (beforeWrite?.generation !== cmd.generation) {
            if (beforeWrite) {
              beforeWrite.commands = beforeWrite.commands.filter(
                (c) => c.id !== cmd.id,
              );
              this.save(beforeWrite);
            }
            continue;
          }
          const client = new BusyClient(token, this.env.BUSY_UPSTREAM, () => {
            requireThat(
              this.load()?.generation === cmd.generation,
              "STALE_TARGET",
              409,
            );
          });
          if (cmd.kind === "clear")
            await client.request(
              "DELETE",
              "/display/draw?application_name=" + NAMESPACE,
              cmd.elementIds
                ? { application_name: NAMESPACE, element_ids: cmd.elementIds }
                : undefined,
            );
          else if (cmd.kind === "upload") {
            const slot = s.slots.find(
              (v) => v.slot === cmd.slot && v.hash === cmd.hash,
            );
            requireThat(
              slot && cmd.hash && s.assets[cmd.hash],
              "ASSET_MISSING",
              409,
            );
            await client.request(
              "POST",
              `/assets/upload?application_name=${NAMESPACE}&file=slot-${slot.slot}.${slot.type}`,
              unbase64(s.assets[cmd.hash].data),
            );
          } else {
            const current = s.selected ? s.items[s.selected] : null;
            requireThat(current, "STALE_TARGET", 409);
            const remaining = current.remainingMs ?? 60000;
            const ttl = Math.max(
              1,
              Math.min(
                60,
                Math.ceil(
                  (remaining + current.scene.entryDurationMs + 3000) / 1000,
                ),
              ),
            );
            const elements = (cmd.elements ?? []).map((e) => {
              const { assetHash, ...native } = e;
              if (assetHash) {
                const slot = s.slots.find(
                  (slot) => slot.hash === assetHash && slot.uploaded,
                );
                requireThat(slot, "ASSET_MISSING", 409);
                native.path = `slot-${slot.slot}.${slot.type}`;
              }
              native.timeout = e.type === "text" ? ttl : 60;
              return native;
            });
            drawSentAt = Date.now();
            drawExpiresAt = drawSentAt + ttl * 1000;
            await client.request("POST", "/display/draw", {
              application_name: NAMESPACE,
              priority: NATIVE_PRIORITY,
              ...(current.scene.ledColor
                ? { led_notification_color: current.scene.ledColor }
                : {}),
              elements,
            });
          }
        } catch (error) {
          failed = error;
        }
        const live = this.load();
        if (!live) break;
        const currentCommand = live.commands.find((c) => c.id === cmd.id);
        if (!currentCommand) continue;
        if (failed) {
          console.warn("Device command failed", {
            kind: cmd.kind,
            code:
              failed instanceof ProtocolError ? failed.code : "UNKNOWN_FAILURE",
          });
          tick(live, Date.now());
          live.visibleSince = null;
          live.applying = live.selected;
          currentCommand.status = "pending";
          currentCommand.dueAt =
            Date.now() +
            Math.min(60000, 1000 * 2 ** Math.min(currentCommand.attempts, 6));
          live.health.status =
            failed instanceof ProtocolError && failed.code === "DEVICE_BLOCKED"
              ? "blocked"
              : "offline";
          live.health.confirmedValidUntil = 0;
          live.displaying = null;
          live.revision++;
          this.save(live);
          break;
        }
        live.commands = live.commands.filter((c) => c.id !== cmd.id);
        if (cmd.kind === "upload") {
          const slot = live.slots.find(
            (slot) => slot.slot === cmd.slot && slot.hash === cmd.hash,
          );
          if (slot) slot.uploaded = true;
        }
        if (cmd.generation === live.generation) {
          const acceptedAt = Date.now();
          if (cmd.kind === "draw") {
            if (live.entryAt === null && !cmd.refresh) {
              const item = live.selected ? live.items[live.selected] : null;
              if (item) live.entryAt = acceptedAt + item.scene.entryDurationMs;
              const delay = acceptedAt - cmd.dueAt;
              for (const following of live.commands)
                if (
                  following.generation === live.generation &&
                  !following.refresh
                )
                  following.dueAt += delay;
            }
            if (drawExpiresAt !== undefined && drawSentAt !== undefined)
              for (const element of cmd.elements ?? []) {
                const expiresAt =
                  element.type === "text" ? drawExpiresAt : drawSentAt + 60000;
                live.elementExpiries[element.id] = {
                  type: element.type,
                  expiresAt,
                };
                live.nativeElements[element.id] = element;
              }
          }
          if (cmd.kind === "clear") {
            if (cmd.elementIds)
              for (const id of cmd.elementIds) {
                delete live.elementExpiries[id];
                delete live.nativeElements[id];
              }
            else {
              live.elementExpiries = {};
              live.nativeElements = {};
            }
          }
          if (
            cmd.kind === "draw" ||
            (cmd.kind === "clear" && currentCommand.itemKey)
          )
            this.acknowledgeNativeContent(live, currentCommand, acceptedAt);
          if (cmd.kind === "clear" && !live.selected) {
            live.health = {
              status: "healthy",
              confirmedValidUntil: 0,
              lastSuccessAt: acceptedAt,
            };
            live.applying = null;
          }
        }
        this.save(live);
      }
    } catch (error) {
      const s = this.load();
      if (s) {
        const first = s.commands[0];
        if (first) {
          first.status = "pending";
          first.attempts++;
          first.dueAt = Date.now() + 60000;
        }
        s.health.status = "blocked";
        s.health.confirmedValidUntil = 0;
        s.revision++;
        this.save(s);
      }
    } finally {
      this.dispatching = false;
      await this.arm();
    }
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      requireThat(!url.search, "PARAMS_NOT_ALLOWED");
      if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
      if (path === "/api/mode" && request.method === "GET")
        return json({ demo: !!env.BUSY_UPSTREAM });
      const mutation = !["GET", "HEAD"].includes(request.method);
      const cookie = request.headers
        .get("Cookie")
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("busy_session="))
        ?.slice(13);
      const bearer = request.headers.get("Authorization");
      requireThat(!(cookie && bearer), "AMBIGUOUS_AUTH", 401);
      if (mutation && !bearer)
        requireThat(
          request.headers.get("Origin") === url.origin &&
            url.origin === env.PUBLIC_ORIGIN,
          "ORIGIN_REJECTED",
          403,
        );
      const body =
        mutation && request.method !== "DELETE"
          ? await jsonBody(request, path === "/api/assets" ? 400000 : 131072)
          : {};
      if (path === "/api/session" && request.method === "POST") {
        const token = text(body.token, 1024);
        const status = record(
          await new BusyClient(token, env.BUSY_UPSTREAM).request(
            "GET",
            "/status",
          ),
        );
        const device = record(status.device);
        const serial = text(device.serial_number, 128);
        requireThat(
          /^[A-Za-z0-9_-]{4,128}$/.test(serial),
          "DEVICE_IDENTITY_REQUIRED",
          502,
        );
        const deviceId = await digest(serial),
          id = crypto.randomUUID(),
          expiresAt = Date.now() + 12 * 3600000;
        await env.DEVICES.getByName(deviceId).login(
          deviceId,
          await encrypt(token, env.TOKEN_ENCRYPTION_KEY),
          id,
          expiresAt,
        );
        const signed = await signSession(
          { deviceId, id, expiresAt },
          env.SESSION_SIGNING_KEY,
        );
        return json({ deviceId, demo: !!env.BUSY_UPSTREAM }, 200, {
          "Set-Cookie": `busy_session=${encodeURIComponent(signed)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
        });
      }
      let deviceId: string, auth: Auth;
      if (bearer) {
        const match =
          /^Bearer ([a-f0-9]{64})\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{40,64})$/.exec(
            bearer,
          );
        requireThat(match, "UNAUTHORIZED", 401);
        deviceId = match[1];
        auth = {
          kind: "publisher",
          serviceId: match[2],
          hash: await digest(match[3]),
        };
      } else {
        requireThat(cookie, "UNAUTHORIZED", 401);
        const session = await verifySession(
          decodeURIComponent(cookie),
          env.SESSION_SIGNING_KEY,
          Date.now(),
        );
        requireThat(session, "UNAUTHORIZED", 401);
        const expectedDevice = request.headers.get("X-Busy-Device");
        if (
          mutation &&
          !(path === "/api/session" && request.method === "DELETE")
        )
          requireThat(expectedDevice !== null, "DEVICE_BINDING_REQUIRED", 403);
        if (expectedDevice !== null)
          requireThat(
            expectedDevice === session.deviceId,
            "DEVICE_SESSION_CHANGED",
            409,
          );
        deviceId = session.deviceId;
        auth = {
          kind: "session",
          id: session.id,
          expiresAt: session.expiresAt,
        };
      }
      if (
        path.startsWith("/api/preview/") &&
        !(path === "/api/preview/viewer" && request.method === "POST")
      ) {
        requireThat(request.method === "GET", "NOT_FOUND", 404);
        // Do not proxy user headers or URLs into the DO. Authentication is independently
        // checked against current persisted state before a transport is opened.
        const forwarded = new Headers({
          "X-Busy-Internal-Auth": JSON.stringify(auth),
        });
        for (const key of ["Upgrade", "X-Busy-Instance", "X-Busy-Epoch"]) {
          const value = request.headers.get(key);
          if (value !== null) forwarded.set(key, value);
        }
        return await env.DEVICES.getByName(deviceId).fetch(
          new Request("https://device.internal" + path, {
            headers: forwarded,
            signal: request.signal,
          }),
        );
      }
      return await env.DEVICES.getByName(deviceId).handle(
        auth,
        path,
        request.method,
        body,
      );
    } catch (error) {
      return safeError(error);
    }
  },
} satisfies ExportedHandler<RuntimeEnv>;
