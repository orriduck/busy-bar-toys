import { StateStore } from "./store";
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
import { BusyClient, NAMESPACE } from "./busy";
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
  private dispatching = false;
  private lastBroadcastRevision: number | null = null;
  private streams = new Map<
    string,
    {
      auth: Auth;
      controller: ReadableStreamDefaultController<Uint8Array>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env);
    this.store = new StateStore(ctx.storage);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL)",
    );
    const s = this.load();
    if (s && s.commands.some((c) => c.status === "inflight")) {
      tick(s, Date.now());
      const item = s.selected ? s.items[s.selected] : null;
      s.commands = [];
      s.generation++;
      s.displaying = null;
      s.applying = s.selected;
      s.visibleSince = null;
      s.entryAt = null;
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
          const oldElements = new Map<string, Element>();
          const newElements = new Map<string, Element>();
          for (const c of old!.scene.commands)
            for (const e of c.elements) oldElements.set(e.id, e);
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
          if (removed.length || transitioned.length)
            enqueue(s, {
              generation: s.generation,
              kind: "clear",
              dueAt: now,
              elementIds: [...removed, ...transitioned],
              refresh: true,
            });
          if (changed.length)
            enqueue(s, {
              generation: s.generation,
              kind: "draw",
              dueAt: now,
              elements: changed,
              refresh: true,
              itemKey: item.itemKey,
              itemVersion: item.version,
            });
          else if (s.displaying?.itemKey === item.itemKey) {
            const admission = s.admission.find(
              (a) => a.itemKey === item.itemKey,
            );
            if (admission) admission.version = item.version;
          }
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
        const latest = new Map<string, Element>();
        for (const c of item.scene.commands)
          for (const e of c.elements) latest.set(e.id, e);
        const changed = elements.filter(
          (e) => JSON.stringify(e) !== JSON.stringify(latest.get(e.id)),
        );
        requireThat(
          version !== item.version || changed.length === 0,
          "STALE_VERSION",
          409,
        );
        if (version === item.version)
          return json({ snapshot: snapshot(s, now, id) });
        for (const e of elements)
          if (e.assetHash)
            requireThat(
              s.assets[e.assetHash]?.owners.includes(id),
              "ASSET_NOT_AUTHORIZED",
              403,
            );
        const transitioned: string[] = [];
        for (const e of elements)
          for (const c of item.scene.commands) {
            const prior = c.elements.find((old) => old.id === e.id);
            if (prior && prior.type !== e.type) transitioned.push(e.id);
          }
        if (transitioned.length)
          enqueue(s, {
            generation: s.generation,
            kind: "clear",
            dueAt: now,
            elementIds: [...new Set(transitioned)],
            refresh: true,
          });
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
        requireThat(
          JSON.stringify(item.scene).length <= 32768,
          "SCENE_CAPACITY",
          413,
        );
        item.scene = validateScene(item.scene);
        item.version = version;
        if (changed.length)
          enqueue(s, {
            generation: s.generation,
            kind: "draw",
            dueAt: now,
            elements: changed,
            refresh: true,
            itemKey: item.itemKey,
            itemVersion: version,
          });
        else if (s.displaying?.itemKey === item.itemKey) {
          const admission = s.admission.find((a) => a.itemKey === item.itemKey);
          if (admission) admission.version = version;
        }
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
          () => {
            try {
              controller.close();
            } catch {}
            this.streams.delete(id);
          },
          Math.min(
            55000,
            auth.kind === "session" ? auth.expiresAt - Date.now() : 55000,
          ),
        );
        this.streams.set(id, { auth, controller, timer });
        controller.enqueue(this.frame(s, auth));
      },
      cancel: () => {
        const entry = this.streams.get(id);
        if (entry) clearTimeout(entry.timer);
        this.streams.delete(id);
      },
    });
    return new Response(stream, {
      headers: {
        ...headers,
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      },
    });
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
        try {
          entry.controller.close();
        } catch {}
        clearTimeout(entry.timer);
        this.streams.delete(id);
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
  private refresh(s: State, now: number) {
    if (!s.selected || s.applying) return;
    const item = s.items[s.selected];
    if (!item) return;
    const latest = new Map<string, Element>();
    for (const command of item.scene.commands)
      for (const element of command.elements) latest.set(element.id, element);
    const texts = [...latest.values()].filter((e) => e.type === "text"),
      widgets = [...latest.values()].filter((e) => e.type !== "text");
    const long = item.remainingMs === null || item.remainingMs > 12000;
    if (s.nextTextAt !== null && s.nextTextAt <= now) {
      if (
        long &&
        texts.length &&
        !s.commands.some(
          (c) => c.refresh && c.elements?.some((e) => e.type === "text"),
        )
      )
        enqueue(s, {
          generation: s.generation,
          kind: "draw",
          dueAt: now,
          elements: texts,
          refresh: true,
        });
      s.nextTextAt = long ? now + 45000 : null;
    }
    if (s.nextWidgetAt !== null && s.nextWidgetAt <= now) {
      if (
        widgets.length &&
        !s.commands.some(
          (c) => c.refresh && c.elements?.some((e) => e.type !== "text"),
        )
      )
        enqueue(s, {
          generation: s.generation,
          kind: "draw",
          dueAt: now,
          elements: widgets,
          refresh: true,
        });
      s.nextWidgetAt = now + 45000;
    }
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
          const client = new BusyClient(token, this.env.BUSY_UPSTREAM);
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
            await client.request("POST", "/display/draw", {
              application_name: NAMESPACE,
              priority: 50,
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
            if (
              cmd.itemKey === live.selected &&
              cmd.itemVersion &&
              live.items[cmd.itemKey]?.version === cmd.itemVersion &&
              !live.commands.some(
                (c) =>
                  c.itemKey === cmd.itemKey &&
                  c.itemVersion === cmd.itemVersion,
              )
            ) {
              const admission = live.admission.find(
                (a) => a.itemKey === cmd.itemKey,
              );
              if (admission) admission.version = cmd.itemVersion;
            }
            const futureEntrance = live.commands.some(
              (c) =>
                c.generation === live.generation &&
                !c.refresh &&
                c.kind === "draw",
            );
            if (!futureEntrance && live.applying)
              acceptDisplay(live, live.generation, acceptedAt);
            else if (cmd.refresh && live.selected) {
              live.health = {
                status: "healthy",
                confirmedValidUntil: acceptedAt + 60000,
                lastSuccessAt: acceptedAt,
              };
              live.displaying = {
                itemKey: live.selected,
                generation: live.generation,
                confirmedAt: acceptedAt,
                confirmedValidUntil: acceptedAt + 60000,
              };
              live.revision++;
            }
          }
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
        deviceId = session.deviceId;
        auth = {
          kind: "session",
          id: session.id,
          expiresAt: session.expiresAt,
        };
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
