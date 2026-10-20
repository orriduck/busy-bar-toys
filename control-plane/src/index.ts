import { migratePriorityGroups } from "./priority-groups";
import { migrateServiceOrders } from "./ordering";
import { retireApprovedLegacyRegistrations } from "./retirements";
import { StateStore } from "./store";
import {
  activeComputer,
  beginEnrollment,
  claimLegacy,
  equalHash,
  expireComputerCodes,
  issuePairing,
  migrateComputerIds,
  ownedService,
  redeemEnrollment,
  redeemPairing,
  reorderOwnedServices,
  reorderOwnedGroups,
  sessionComputer,
} from "./computers";
import { PreviewRelay } from "./preview";
import {
  PREPARED_ENTRY_PREFIX,
  PREPARED_BLACK_MS,
  PREPARED_NATIVE_ELEMENT_LIMIT,
  preparedBlackAssets,
  preparedBlackElements,
  materializePreparedElements,
  setPreparedEntryIds,
  hideObsoleteElement,
  upgradePreparedElementIds,
} from "./prepared-handoff";
import {
  BLACK_MS,
  FADE_MS,
  ServiceMotionClock,
  motionFenceTimer,
  waitForMotionFence,
  cacheNativeMotionAssets,
  cacheInternalAssets,
  isMotionElement,
  motionElements,
  nativeMotionElements,
  nativeMotionCapacity,
  reuseNativeMotionSlots,
  unmaskMotionElement,
  visibleHandoff,
} from "./service-motion";
import { DurableObject } from "cloudflare:workers";
import {
  Action,
  Command,
  Element,
  Item,
  ProtocolError,
  State,
  Slot,
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
  removeService,
  requestAction,
  requireThat,
  snapshot,
  text,
  tick,
  turnDeadline,
  validateElements,
  validateScene,
} from "./model";
import { BusyClient, NAMESPACE, NATIVE_PRIORITY } from "./busy";
import { storeAsset, pinnedSlots, reserveSlots } from "./assets";
import {
  BROWSER_SESSION_SECONDS,
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
  | { kind: "computer"; computerId: string; hash: string; serviceId?: string }
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
  private motionClock = new ServiceMotionClock();
  private motionFenceWait = motionFenceTimer;
  private lastBroadcastRevision: number | null = null;
  private streamStats = {
    opened: 0,
    capacityRejected: 0,
    capacityRejectedByKind: { session: 0, computer: 0, publisher: 0 },
    coalesced: 0,
    closed: { cancelled: 0, lifetime: 0, backpressure: 0, authority: 0 },
  };
  private streams = new Map<
    string,
    {
      auth: Auth;
      controller: ReadableStreamDefaultController<Uint8Array>;
      timer: ReturnType<typeof setTimeout>;
      heartbeat: ReturnType<typeof setInterval>;
      dirty: boolean;
      openedAt: number;
      queuedAt: number | null;
    }
  >();
  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env);
    this.store = new StateStore(ctx.storage);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS display_diagnostics (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)",
    );
    const s = this.load();
    if (s) {
      const identities = migrateComputerIds(s);
      const orders = migrateServiceOrders(s, Date.now());
      const retirements = retireApprovedLegacyRegistrations(s);
      const priorityGroups = migratePriorityGroups(s);
      if (identities || orders || retirements || priorityGroups) this.save(s);
    }
    if (s) this.preview.update(s);
    if (s && s.commands.some((c) => c.status === "inflight")) {
      this.recoverScene(s, Date.now(), "inflight_restart");
      this.save(s);
    }
  }
  private traceDisplay(
    kind:
      | "handoff"
      | "reclaim"
      | "recovery"
      | "clear"
      | "command_ack"
      | "command_failed"
      | "motion_fallback"
      | "prepared_handoff"
      | "prepared_alias"
      | "retirement_expired",
    data: {
      generation: number;
      command?: Command["kind"];
      reason?:
        | "inflight_restart"
        | "uncertain_draw"
        | "asset_cache"
        | "animation_slots"
        | "incoming_slot_count"
        | "incoming_slot_bytes"
        | "prepared_type_conflict"
        | "prepared_draw_capacity"
        | "prepared_native_capacity"
        | "orphan_legacy_mask";
      stage?: "prepare" | "commit" | "retire";
      expectedBlackMs?: number;
      pendingUploads?: number;
      requestMs?: number;
      preRequestMs?: number;
      filenameType?: string;
      assetType?: string;
      cachedAssets?: number;
      cachedAssetBytes?: number;
      missingMotionAssets?: number;
      slotCount?: number;
      slotBytes?: number;
      pinnedSlotCount?: number;
      reusableAnimationSlots?: number;
      scope?: "selective" | "full";
      outgoingElements?: number;
      retainedElements?: number;
      incomingElements?: number;
      typeConflicts?: number;
      obsoleteElements?: number;
      outgoingExpiryMs?: number | null;
      elementCount?: number | null;
      hasNextScene?: boolean;
      elapsedMs?: number;
      code?: string;
    },
  ) {
    const at = Date.now();
    if (kind === "command_failed") console.warn("Device command failed", data);
    else if (kind !== "command_ack") console.info("Display " + kind, data);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO display_diagnostics(at,kind,data) VALUES(?,?,?)",
        at,
        kind,
        JSON.stringify(data),
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM display_diagnostics WHERE at<? OR id NOT IN (SELECT id FROM display_diagnostics ORDER BY id DESC LIMIT 128)",
        at - 3600000,
      );
    });
  }
  private recoverScene(
    s: State,
    now: number,
    reason: "inflight_restart" | "uncertain_draw",
  ) {
    this.traceDisplay("recovery", { reason, generation: s.generation });
    tick(s, now);
    const item = s.selected ? s.items[s.selected] : null;
    s.nativeRecoveryRequired = false;
    // An uncertain write still requires the existing namespace recovery. Do not
    // replay a partly observed transition or let its opaque masks survive it.
    delete s.serviceMotion;
    this.motionClock.reset();
    s.commands = [];
    s.generation++;
    setPreparedEntryIds(s);
    s.displaying = null;
    s.applying = s.selected;
    s.visibleSince = null;
    s.entryAt = null;
    s.elementExpiries = {};
    s.nativeElements = {};
    enqueue(s, { generation: s.generation, kind: "clear", dueAt: now });
    if (item)
      for (const [index, c] of item.scene.commands.entries())
        enqueue(s, {
          generation: s.generation,
          kind: "draw",
          dueAt: now + c.offsetMs,
          elements: c.elements,
          ...(index === 0 && item.scene.entryLeadMs === 200
            ? { handoff: true, prepared: "pending" as const }
            : {}),
        });
    s.revision++;
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
    if (auth.kind === "computer") {
      const computer = activeComputer(s, auth.computerId);
      requireThat(
        equalHash(computer.credentialHash, auth.hash),
        "UNAUTHORIZED",
        401,
      );
      if (auth.serviceId) ownedService(s, computer.id, auth.serviceId);
      return auth.serviceId;
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
        auth &&
          (auth.kind === "session" ||
            auth.kind === "publisher" ||
            auth.kind === "computer"),
        "FORBIDDEN",
        403,
      );
      const s = this.load();
      requireThat(s, "UNAUTHORIZED", 401);
      this.authorize(s, auth);
      this.preview.update(s);
      if (url.pathname === "/api/preview/publish") {
        requireThat(
          auth.kind !== "session" && auth.serviceId,
          "FORBIDDEN",
          403,
        );
        requireThat(
          request.headers.get("Upgrade")?.toLowerCase() === "websocket",
          "WEBSOCKET_REQUIRED",
          426,
        );
        return this.preview.openPublisher(
          { ...auth, serviceId: auth.serviceId },
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
  /** The unguessable one-use enrollment ticket is the only authority here. */
  async enroll(
    codeHash: string,
    computerId: string,
    credentialHash: string,
  ): Promise<Response> {
    try {
      const s = this.load();
      requireThat(
        s &&
          /^[a-f0-9]{64}$/.test(codeHash) &&
          /^[a-f0-9]{64}$/.test(credentialHash) &&
          Object.hasOwn(s.enrollments, codeHash) &&
          s.enrollments[codeHash].computerId === computerId,
        "ENROLLMENT_INVALID",
        403,
      );
      const computer = redeemEnrollment(
        s,
        codeHash,
        credentialHash,
        Date.now(),
      );
      this.save(s);
      await this.arm();
      return json(
        {
          computerId: computer.id,
          enrolled: true,
        },
        201,
      );
    } catch (error) {
      return safeError(error);
    }
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
      let pairingHash: string | undefined, pairingDevice: string | undefined;
      if (path === "/api/session/computer" && method === "POST") {
        requireThat(auth.kind === "session", "FORBIDDEN", 403);
        const code = /^pair\.([a-f0-9]{64})\.([A-Za-z0-9_-]{40,64})$/.exec(
          text(body.code, 256),
        );
        requireThat(code, "PAIRING_INVALID", 403);
        pairingDevice = code[1];
        pairingHash = await digest(code[2]);
      }
      const proofs: Record<string, string> = {};
      if (path === "/api/computers/claim" && method === "POST") {
        requireThat(auth.kind === "publisher", "FORBIDDEN", 403);
        const secret = text(body.managementSecret, 64);
        requireThat(
          /^[A-Za-z0-9_-]{40,64}$/.test(secret),
          "INVALID_COMPUTER_CREDENTIAL",
        );
        newHash = await digest(secret);
        const values = record(body.proofs);
        requireThat(
          Object.keys(values).length > 0 && Object.keys(values).length <= 32,
          "COMPUTER_PROOF_REQUIRED",
          403,
        );
        for (const [id, raw] of Object.entries(values)) {
          identifier(id);
          requireThat(typeof raw === "string", "COMPUTER_PROOF_REQUIRED", 403);
          const match =
            /^([a-f0-9]{64})\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{40,64})$/.exec(
              raw,
            );
          requireThat(match && match[2] === id, "COMPUTER_PROOF_REQUIRED", 403);
          // Device matching is checked after loading the authoritative state.
          proofs[match[1] + ":" + id] = await digest(match[3]);
        }
      }
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
        (path === "/api/computers/enrollment" ||
          path === "/api/computers/pairing" ||
          path === "/api/services" ||
          /^\/api\/services\/[\w-]+\/credential$/.test(path))
      ) {
        requireThat(
          auth.kind !== "publisher" || path === "/api/computers/claim",
          "FORBIDDEN",
          403,
        );
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
      const managementComputer = () => {
        requireThat(auth.kind !== "publisher", "FORBIDDEN", 403);
        const id =
          auth.kind === "computer"
            ? auth.computerId
            : auth.kind === "session"
              ? sessionComputer(s, auth.id, now)
              : null;
        requireThat(id, "COMPUTER_PAIRING_REQUIRED", 403);
        activeComputer(s, id);
        return id;
      };
      const serviceWrite =
        (method === "PATCH" && /^\/api\/services\/[\w-]+$/.test(path)) ||
        (method === "POST" &&
          (path === "/api/services" ||
            /^\/api\/services\/[\w-]+\/(order|revoke|credential|remove)$/.test(
              path,
            ) ||
            path === "/api/services/order"));
      // Ownership is checked before tick, scheduling, or any durable mutation.
      if (serviceWrite) {
        const owner = managementComputer();
        if (path === "/api/services")
          requireThat(
            body.computerId === undefined || body.computerId === owner,
            "SERVICE_NOT_OWNED",
            403,
          );
        else if (path !== "/api/services/order")
          ownedService(s, owner, path.split("/")[3]);
      }
      if (body.serviceId !== undefined)
        requireThat(
          body.serviceId === serviceId,
          "SERVICE_TARGET_MISMATCH",
          403,
        );
      if (
        auth.kind === "computer" &&
        method === "POST" &&
        [
          "/api/publish",
          "/api/update",
          "/api/end",
          "/api/withdraw",
          "/api/heartbeat",
          "/api/assets",
          "/api/input",
          "/api/actions",
        ].includes(path)
      )
        requireThat(serviceId, "SERVICE_TARGET_REQUIRED", 403);
      const orderingServices =
        path === "/api/services/order" && method === "POST";
      // Order validation must precede tick: rejected requests cannot advance playback.
      if (orderingServices) managementComputer();
      if (path === "/api/preview/viewer" && method === "POST") {
        requireThat(auth.kind === "session", "FORBIDDEN", 403);
        this.preview.update(s);
        return json(
          this.preview.viewer(auth, identifier(body.viewerId), body.operation),
        );
      }
      const removingService =
        /^\/api\/services\/[\w-]+\/remove$/.test(path) && method === "POST";
      if (removingService) managementComputer();
      const computerOperation =
        path.startsWith("/api/computers/") || path === "/api/session/computer";
      if (!orderingServices && !removingService && !computerOperation)
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
        else {
          const owner = managementComputer();
          ownedService(s, owner, item.serviceId);
        }
        return item;
      };
      let response: Response | undefined;
      if (path === "/api/computers/enrollment" && method === "POST") {
        admin();
        requireThat(auth.kind === "session", "FORBIDDEN", 403);
        const computerId = crypto.randomUUID();
        const ticket = beginEnrollment(s, auth.id, newHash!, computerId, now);
        response = json(
          {
            computerId,
            enrollment: `enroll.${s.deviceId}.${computerId}.${newSecret}`,
            expiresAt: ticket.expiresAt,
          },
          201,
        );
      } else if (path === "/api/computers/claim" && method === "POST") {
        requireThat(auth.kind === "publisher", "FORBIDDEN", 403);
        const scoped: Record<string, string> = {};
        for (const [key, value] of Object.entries(proofs)) {
          requireThat(
            key.startsWith(s.deviceId + ":"),
            "COMPUTER_PROOF_REQUIRED",
            403,
          );
          scoped[key.slice(s.deviceId.length + 1)] = value;
        }
        const computer = claimLegacy(s, auth.serviceId, scoped, newHash!, now);
        response = json(
          {
            computerId: computer.id,
            enrolled: true,
          },
          201,
        );
      } else if (path === "/api/computers/pairing" && method === "POST") {
        requireThat(auth.kind === "computer", "FORBIDDEN", 403);
        const code = issuePairing(s, auth.computerId, newHash!, now);
        response = json(
          {
            code: `pair.${s.deviceId}.${newSecret}`,
            expiresAt: code.expiresAt,
          },
          201,
        );
      } else if (path === "/api/session/computer" && method === "POST") {
        admin();
        requireThat(auth.kind === "session", "FORBIDDEN", 403);
        requireThat(pairingDevice === s.deviceId, "PAIRING_INVALID", 403);
        const computerId = redeemPairing(s, auth.id, pairingHash!, now);
        response = json({ computerId });
      } else if (path === "/api/computer" && method === "GET") {
        requireThat(auth.kind === "computer", "FORBIDDEN", 403);
        response = json({
          computerId: auth.computerId,
          deviceId: s.deviceId,
          configRevision: s.configRevision,
          services: snapshot(s, now).services.filter(
            (service) => service.computerId === auth.computerId,
          ),
        });
      } else if (path === "/api/session" && method === "GET") {
        admin();
        response = json({
          deviceId: s.deviceId,
          demo: !!this.env.BUSY_UPSTREAM,
          computerId:
            auth.kind === "session" ? sessionComputer(s, auth.id, now) : null,
        });
      } else if (path === "/api/session" && method === "DELETE") {
        admin();
        if (auth.kind === "session") {
          delete s.sessions[auth.id];
          delete s.sessionComputers[auth.id];
        }
        response = json({ ok: true }, 200, {
          "Set-Cookie":
            "busy_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
        });
      } else if (path === "/api/snapshot" && method === "GET")
        response = json({
          ...snapshot(s, now, serviceId),
          demo: !!this.env.BUSY_UPSTREAM,
        });
      else if (path === "/api/diagnostics/display" && method === "GET") {
        requireThat(
          !serviceId && (auth.kind === "session" || auth.kind === "computer"),
          "FORBIDDEN",
          403,
        );
        response = json({
          implementation: "shared-service-motion-v2-prepared",
          snapshotStreams: this.snapshotStreamHealth(),
          generation: s.generation,
          nativeElements: Object.keys(s.nativeElements).length,
          earliestExpiryMs: Object.keys(s.nativeElements).length
            ? Math.min(
                ...Object.values(s.elementExpiries).map((e) => e.expiresAt),
              ) - now
            : null,
          pending: s.commands.map((c) => ({
            kind: c.kind,
            status: c.status,
            attempts: c.attempts,
            dueInMs: c.dueAt - now,
          })),
          events: this.ctx.storage.sql
            .exec<{ at: number; kind: string; data: string }>(
              "SELECT at,kind,data FROM display_diagnostics WHERE at>=? ORDER BY id",
              now - 3600000,
            )
            .toArray()
            .map((e) => ({ ...e, data: JSON.parse(e.data) })),
        });
      } else if (path === "/api/events" && method === "GET") {
        this.save(s);
        await this.arm();
        return this.openStream(s, auth);
      } else if (orderingServices) {
        (body.groups === undefined ? reorderOwnedServices : reorderOwnedGroups)(
          s,
          managementComputer(),
          body.groups === undefined ? body.serviceIds : body.groups,
          body.expectedRevision,
        );
        tick(s, now);
        response = json({ snapshot: snapshot(s, now) });
      } else if (path === "/api/services" && method === "POST") {
        const owner = managementComputer();
        requireThat(
          body.expectedRevision === s.configRevision,
          "CONFIG_CONFLICT",
          409,
        );
        const svc = registerService(
          s,
          { ...body, computerId: owner },
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
        managementComputer();
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
        managementComputer();
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
      } else if (removingService) {
        managementComputer();
        removeService(
          s,
          path.split("/")[3],
          Number(body.expectedRevision),
          now,
        );
        response = json({ snapshot: snapshot(s, now) });
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
            for (const e of materializePreparedElements(s, c.elements))
              newElements.set(e.id, e);
          const entryId =
            s.preparedEntryIds?.["shared-service-entry"] ??
            "shared-service-entry";
          const changed = [...newElements.values()].filter(
            (e) =>
              e.id !== entryId &&
              JSON.stringify(e) !== JSON.stringify(oldElements.get(e.id)),
          );
          const removed = [...oldElements.keys()].filter(
            (id) =>
              !newElements.has(id) && !isMotionElement(id) && id !== entryId,
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
      } else if (
        (path === "/api/end" || path === "/api/withdraw") &&
        method === "POST"
      ) {
        const id = producer();
        const reason = path === "/api/withdraw" ? "withdrawn" : "resolved";
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
            reason,
          };
          s.revision++;
        }
        finishItem(
          s,
          key,
          reason,
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
        requireThat(
          elements.every(
            (e) =>
              !isMotionElement(e.id) &&
              !e.id.startsWith(PREPARED_ENTRY_PREFIX) &&
              Number(e.z_index ?? 0) < 255,
          ),
          "COMPOSITOR_LAYER_RESERVED",
        );
        const recoveryScene =
          body.scene === undefined ? undefined : validateScene(body.scene);
        const latest = this.projectedNativeElements(s);
        const wireElements = materializePreparedElements(s, elements);
        const changed = wireElements.filter(
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
        const transitioned = wireElements
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
        const item = s.items[text(body.itemKey, 512)];
        requireThat(item, "ITEM_NOT_FOUND", 404);
        ownedService(s, managementComputer(), item.serviceId);
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
        requireThat(auth.kind !== "session", "PHYSICAL_INPUT_REQUIRED", 403);
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
      expireComputerCodes(s, now);
      this.save(s);
      await this.arm();
      this.ctx.waitUntil(this.dispatch());
      return response;
    } catch (error) {
      return safeError(error);
    }
  }
  private openStream(s: State, auth: Auth) {
    if (this.streams.size >= 16) {
      this.streamStats.capacityRejected++;
      this.streamStats.capacityRejectedByKind[auth.kind]++;
    }
    requireThat(this.streams.size < 16, "SSE_CAPACITY", 429);
    const id = crypto.randomUUID();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const timer = setTimeout(
          () => this.closeStream(id, "lifetime"),
          Math.min(
            55000,
            auth.kind === "session" ? auth.expiresAt - Date.now() : 55000,
          ),
        );
        const heartbeat = setInterval(() => {
          try {
            const entry = this.streams.get(id);
            if (!entry) return;
            const current = this.load();
            requireThat(current, "UNAUTHORIZED", 401);
            this.authorize(current, auth);
            if ((controller.desiredSize ?? 0) <= 0) {
              entry.queuedAt ??= Date.now();
              // A snapshot may have arrived immediately before this heartbeat.
              // Reclaim only after an actual two-second blocked interval.
              if (Date.now() - entry.queuedAt >= 2000)
                this.closeStream(id, "backpressure");
              return;
            }
            entry.queuedAt = null;
            if (this.streams.get(id)?.dirty) {
              this.flushSnapshotStream(id);
              return;
            }
            // Keep the producer's five-second socket read alive without
            // inventing a revision or repeating its full snapshot.
            controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
            this.noteStreamQueue(id);
          } catch {
            this.closeStream(id, "authority");
          }
        }, 2000);
        this.streams.set(id, {
          auth,
          controller,
          timer,
          heartbeat,
          dirty: false,
          openedAt: Date.now(),
          queuedAt: null,
        });
        this.streamStats.opened++;
        controller.enqueue(this.frame(s, auth));
        this.noteStreamQueue(id);
      },
      pull: () => this.flushSnapshotStream(id),
      cancel: () => this.closeStream(id),
    });
    return new Response(stream, {
      headers: {
        ...headers,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
      },
    });
  }
  private closeStream(
    id: string,
    reason: keyof typeof this.streamStats.closed = "cancelled",
  ) {
    const entry = this.streams.get(id);
    if (!entry) return;
    this.streams.delete(id);
    this.streamStats.closed[reason]++;
    clearTimeout(entry.timer);
    clearInterval(entry.heartbeat);
    try {
      entry.controller.close();
    } catch {}
  }
  private snapshotStreamHealth() {
    const activeByKind = { session: 0, computer: 0, publisher: 0 };
    let pending = 0,
      oldestAgeMs = 0,
      backpressured = 0,
      oldestBackpressureAgeMs = 0;
    const services = new Map<string, number>();
    for (const entry of this.streams.values()) {
      activeByKind[entry.auth.kind]++;
      pending += Number(entry.dirty);
      oldestAgeMs = Math.max(oldestAgeMs, Date.now() - entry.openedAt);
      if (entry.queuedAt !== null) {
        backpressured++;
        oldestBackpressureAgeMs = Math.max(
          oldestBackpressureAgeMs,
          Date.now() - entry.queuedAt,
        );
      }
      if (entry.auth.kind !== "session" && entry.auth.serviceId) {
        const key = entry.auth.serviceId;
        services.set(key, (services.get(key) ?? 0) + 1);
      }
    }
    return {
      active: this.streams.size,
      limit: 16,
      activeByKind,
      pending,
      oldestAgeMs,
      backpressured,
      oldestBackpressureAgeMs,
      serviceConnectionCounts: [...services.values()].sort((a, b) => b - a),
      ...this.streamStats,
    };
  }
  private noteStreamQueue(id: string) {
    const entry = this.streams.get(id);
    if (entry)
      entry.queuedAt =
        (entry.controller.desiredSize ?? 0) <= 0 ? Date.now() : null;
  }
  private flushSnapshotStream(id: string) {
    const entry = this.streams.get(id);
    if (!entry || (entry.controller.desiredSize ?? 0) <= 0) return;
    entry.queuedAt = null;
    if (!entry.dirty) return;
    try {
      const current = this.load();
      requireThat(current, "UNAUTHORIZED", 401);
      // Serialize only the newest state when the consumer has room. Never
      // accumulate serialized snapshots or keep an obsolete pending version.
      entry.controller.enqueue(this.frame(current, entry.auth));
      entry.dirty = false;
      this.noteStreamQueue(id);
    } catch {
      this.closeStream(id, "authority");
    }
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
        this.authorize(s, entry.auth);
        if ((entry.controller.desiredSize ?? 0) <= 0) {
          entry.dirty = true;
          this.streamStats.coalesced++;
          continue;
        }
        entry.dirty = false;
        entry.controller.enqueue(this.frame(s, entry.auth));
        this.noteStreamQueue(id);
      } catch {
        this.closeStream(id, "authority");
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
    const turnAt = turnDeadline(s, now);
    if (turnAt !== null) deadlines.push(turnAt);
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
    for (const code of Object.values(s.enrollments))
      deadlines.push(code.expiresAt);
    for (const code of Object.values(s.pairings))
      deadlines.push(code.expiresAt);
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
    expireComputerCodes(s, now);
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
    // Settle the old bounded proof before a renewal extends it. A delayed ACK
    // cannot charge an unconfirmed gap or confirm a generation that just yielded.
    tick(live, acceptedAt);
    if (cmd.generation !== live.generation) return;
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
        ...this.latestElements(live, item).map(
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
  private handoffAnchor(s: State): Element {
    const reserved = new Set([
      ...Object.keys(s.nativeElements),
      ...Object.values(s.items).flatMap((item) =>
        item.scene.commands.flatMap((c) => c.elements.map((e) => e.id)),
      ),
    ]);
    let index = 0;
    while (reserved.has(`control-handoff-${index}`)) index++;
    return {
      id: `control-handoff-${index}`,
      type: "xpmbitmap",
      display: "front",
      x: 0,
      y: 0,
      data: "! XPM2\n1 1 1 1\nB c #000000\nB\n",
    };
  }
  private reclaimHandoff(
    s: State,
    command: Command,
    now: number,
    elementCapacity: boolean,
  ) {
    command.handoffReclaimed = true;
    const anchor = this.handoffAnchor(s);
    const old = Object.keys(s.nativeElements);
    // Inline widgets need no asset slot. Keep the old base view visible while
    // releasing only file-backed widgets; a black anchor is the last resort.
    const motionMasks = old.filter(isMotionElement);
    const inline = elementCapacity
      ? motionMasks
      : old.filter((id) => !s.nativeElements[id].assetHash);
    const retainInline = inline.length > 0 && inline.length < old.length;
    const retired = retainInline
      ? old.filter((id) => !inline.includes(id))
      : [...old];
    this.traceDisplay("reclaim", {
      generation: s.generation,
      outgoingElements: old.length,
      retainedElements: retainInline ? inline.length : 0,
    });
    const prefix: Command[] = [];
    const add = (
      kind: "draw" | "clear",
      elements?: Element[],
      elementIds?: string[],
    ) => {
      enqueue(s, {
        generation: s.generation,
        kind,
        dueAt: now,
        refresh: true,
        elements,
        elementIds,
      });
      prefix.push(s.commands.pop()!);
    };
    // Free one widget if necessary before creating the anchor. The remaining
    // old widgets still retain our namespace until the anchor is acknowledged.
    if (retainInline) {
      // Bound a fresh native lifetime before potentially slow uploads. This is
      // still outgoing content, not proof that the incoming scene is displayed.
      for (let offset = 0; offset < inline.length; offset += 32)
        add(
          "draw",
          inline.slice(offset, offset + 32).map((id) => s.nativeElements[id]),
        );
    } else {
      if (old.length >= 128) add("clear", undefined, [retired.shift()!]);
      add("draw", [anchor]);
    }
    for (let offset = 0; offset < retired.length; offset += 64)
      add("clear", undefined, retired.slice(offset, offset + 64));
    s.commands.splice(s.commands.indexOf(command), 0, ...prefix);
  }
  private prepareHandoff(s: State, command: Command, now: number) {
    if (command.prepared === "pending" || command.prepared === "fallback") {
      const aliases = upgradePreparedElementIds(s, command.elements ?? []);
      if (aliases)
        this.traceDisplay("prepared_alias", {
          generation: s.generation,
          elementCount: aliases,
        });
      const nativeHold = command.prepared === "pending";
      const incoming = new Map((command.elements ?? []).map((e) => [e.id, e])),
        old = Object.values(s.nativeElements),
        conflicts = old.some(
          (e) => incoming.has(e.id) && incoming.get(e.id)!.type !== e.type,
        ),
        hide = old.filter((e) => !incoming.has(e.id)).map(hideObsoleteElement),
        masks = nativeHold ? preparedBlackElements(s.generation) : [];
      const elements = [...hide, ...(command.elements ?? []), ...masks];
      if (
        !conflicts &&
        elements.length <= 32 &&
        new Set([
          ...Object.keys(s.nativeElements),
          ...elements.map((e) => e.id),
        ]).size <= PREPARED_NATIVE_ELEMENT_LIMIT
      ) {
        command.handoff = false;
        command.prepared = nativeHold ? "commit" : "fallback";
        command.elements = elements;
        const item = s.selected ? s.items[s.selected] : undefined;
        if (item) this.bindContentAcknowledgement(s, item);
        // These masks clear themselves on-device after 200ms. Do not retire
        // them over HTTP before that point; the next handoff or TTL retires them.
        const retired = hide.map((e) => e.id);
        const after: Command[] = [];
        for (let offset = 0; offset < retired.length; offset += 64) {
          enqueue(s, {
            generation: s.generation,
            kind: "clear",
            dueAt: now,
            elementIds: retired.slice(offset, offset + 64),
            refresh: true,
            itemKey: command.itemKey,
            itemVersion: command.itemVersion,
            refreshBatch: command.refreshBatch,
          });
          after.push(s.commands.pop()!);
        }
        s.commands.splice(s.commands.indexOf(command) + 1, 0, ...after);
        this.traceDisplay("prepared_handoff", {
          generation: s.generation,
          stage: "prepare",
          expectedBlackMs: nativeHold ? PREPARED_BLACK_MS : 0,
          pendingUploads: 0,
          outgoingElements: old.length,
          incomingElements: incoming.size,
          elementCount: elements.length,
        });
        return;
      }
      this.preparedFallback(
        s,
        command,
        conflicts ? "prepared_type_conflict" : "prepared_draw_capacity",
      );
      if (nativeHold) {
        // Removing the optional masks can make an otherwise safe single draw
        // fit. Never stage the original entrance under opaque old widgets.
        this.prepareHandoff(s, command, now);
        return;
      }
      command.attempts++;
      command.dueAt =
        now + Math.min(60000, 1000 * 2 ** Math.min(command.attempts, 6));
      s.health.status = "blocked";
      s.health.confirmedValidUntil = 0;
      return;
    }
    command.handoff = false;
    const incoming = new Map((command.elements ?? []).map((e) => [e.id, e]));
    const old = Object.values(s.nativeElements);
    const conflicts = old
      .filter((e) => incoming.has(e.id) && incoming.get(e.id)!.type !== e.type)
      .map((e) => e.id);
    const obsolete = old.filter((e) => !incoming.has(e.id)).map((e) => e.id);
    this.traceDisplay("handoff", {
      generation: s.generation,
      outgoingElements: old.length,
      incomingElements: incoming.size,
      typeConflicts: conflicts.length,
      obsoleteElements: obsolete.length,
      outgoingExpiryMs: old.length
        ? Math.min(
            ...old.map((e) => s.elementExpiries[e.id]?.expiresAt ?? now),
          ) - now
        : null,
    });
    const before: Command[] = [],
      after: Command[] = [];
    const item = s.selected ? s.items[s.selected] : null;
    if (!item) return;
    // Admission remains unconfirmed until both the entrance and retirement ACK.
    const batch = ++s.commandSeq;
    const metadata = {
      itemKey: item.itemKey,
      itemVersion: item.version,
      refreshBatch: batch,
    };
    for (const pending of s.commands)
      if (
        pending.generation === s.generation &&
        pending.kind === "draw" &&
        !pending.refresh
      )
        Object.assign(pending, metadata);
    const add = (
      target: Command[],
      value: Omit<Command, "id" | "status" | "attempts">,
    ) => {
      enqueue(s, value);
      target.push(s.commands.pop()!);
    };
    // Preserve the existing clear-before-type-change behavior. If conflicts
    // would remove every widget, a tiny opaque anchor retains our application.
    // Most scenes share the same front/back bitmap types and need no anchor.
    if (conflicts.length && conflicts.length === old.length) {
      const anchor = this.handoffAnchor(s);
      add(before, {
        generation: s.generation,
        kind: "draw",
        dueAt: now,
        refresh: true,
        elements: [anchor],
        ...metadata,
      });
      obsolete.push(anchor.id);
    }
    for (let offset = 0; offset < conflicts.length; offset += 64)
      add(before, {
        generation: s.generation,
        kind: "clear",
        dueAt: now,
        elementIds: conflicts.slice(offset, offset + 64),
        refresh: true,
        ...metadata,
      });
    for (let offset = 0; offset < obsolete.length; offset += 64)
      add(after, {
        generation: s.generation,
        kind: "clear",
        dueAt: now,
        elementIds: obsolete.slice(offset, offset + 64),
        refresh: true,
        ...metadata,
      });
    // Native text scrolls independently above the incoming bitmap. Neutralize it
    // in the same draw, so a slow retirement DELETE cannot overlay the new view.
    const textToHide = old
      .filter((e) => e.type === "text" && !incoming.has(e.id))
      .map((e) => ({
        ...e,
        text: " ",
        scroll_rate: 0,
        scroll_start_delay: 0,
        scroll_repeat_delay: 0,
      }));
    const unmask = old
      .filter((e) => isMotionElement(e.id))
      .map(unmaskMotionElement);
    if (
      textToHide.length + unmask.length + (command.elements?.length ?? 0) <=
      32
    )
      // Incoming content, old-text neutralization and unmask share one native
      // draw. A slow retirement DELETE must not hide the whole entrance.
      command.elements = [
        ...textToHide,
        ...unmask,
        ...(command.elements ?? []),
      ];
    else {
      for (let offset = 0; offset < textToHide.length; offset += 32)
        add(before, {
          generation: s.generation,
          kind: "draw",
          dueAt: now,
          refresh: true,
          elements: textToHide.slice(offset, offset + 32),
          ...metadata,
        });
      if (unmask.length) {
        // The source consumed the whole draw bound. Stage it under black, then
        // unmask and restart only its shared entry helper in a bounded draw.
        // This becomes the first entrance ACK, so scene offsets and Hold begin
        // from the visible entrance rather than the hidden staging request.
        const retirements = after.splice(0);
        const entry = command.elements?.find(
          (e) => e.id === "shared-service-entry",
        );
        command.refresh = true;
        add(after, {
          generation: s.generation,
          kind: "draw",
          // Keep the original zero-offset origin; using preparation time here
          // would shorten the following entrance offsets by preparation delay.
          dueAt: command.dueAt,
          elements: [...unmask, ...(entry ? [entry] : [])],
          ...metadata,
        });
        after.push(...retirements);
      }
    }
    const index = s.commands.indexOf(command);
    s.commands.splice(index, 1, ...before, command, ...after);
  }
  private preparedFallback(
    s: State,
    command: Command,
    reason:
      | "asset_cache"
      | "animation_slots"
      | "incoming_slot_count"
      | "incoming_slot_bytes"
      | "prepared_type_conflict"
      | "prepared_draw_capacity"
      | "prepared_native_capacity",
  ) {
    command.prepared = "fallback";
    delete command.preparedAssetHashes;
    this.traceDisplay("motion_fallback", {
      generation: s.generation,
      command: "draw",
      stage: "prepare",
      reason,
      expectedBlackMs: 0,
      ...nativeMotionCapacity(s, pinnedSlots(s), preparedBlackAssets()),
    });
  }
  private retireOrphanedLegacyMasks(s: State, command: Command, now: number) {
    if (s.serviceMotion || !command.prepared) return false;
    const masks = Object.values(s.nativeElements).filter(
      (e) =>
        isMotionElement(e.id) &&
        !e.id.startsWith("control-service-motion-prepared-"),
    );
    if (!masks.length) return false;
    // Transparent old masks can retire without changing the old picture.
    // An opaque cancelled legacy exit has no device-local reveal. Do not
    // uncover potentially expired/partial old content: return our namespace
    // to the device default while capacity recovery remains pending.
    const selective = masks.every((e) => e.opacity === 0);
    this.traceDisplay("recovery", {
      generation: s.generation,
      reason: "orphan_legacy_mask",
      scope: selective ? "selective" : "full",
      elementCount: masks.length,
    });
    const groups = selective
      ? Array.from({ length: Math.ceil(masks.length / 64) }, (_, n) =>
          masks.slice(n * 64, (n + 1) * 64).map((e) => e.id),
        )
      : [undefined];
    const clears: Command[] = [];
    for (const elementIds of groups) {
      enqueue(s, {
        generation: s.generation,
        kind: "clear",
        dueAt: now,
        elementIds,
      });
      clears.push(s.commands.pop()!);
    }
    s.commands.splice(s.commands.indexOf(command), 0, ...clears);
    s.health.status = "blocked";
    s.health.confirmedValidUntil = 0;
    s.displaying = null;
    s.visibleSince = null;
    // Native inventory and slot pins change only after these clears ACK.
    return true;
  }
  private queueRefresh(
    s: State,
    elements: Element[],
    now: number,
    metadata: Pick<Command, "itemKey" | "itemVersion" | "refreshBatch"> = {},
  ) {
    elements = materializePreparedElements(s, elements);
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
  private latestElements(s: State, item: Item): Element[] {
    const latest = new Map<string, Element>();
    for (const command of item.scene.commands)
      for (const element of materializePreparedElements(s, command.elements))
        latest.set(element.id, element);
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
      const values = this.latestElements(s, item)
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
    const latest = this.latestElements(s, item);
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
        if (s.nativeRecoveryRequired) {
          const retry = s.commands[0];
          if (retry?.status === "pending" && retry.dueAt > now) {
            this.save(s);
            break;
          }
          this.recoverScene(s, now, "uncertain_draw");
        }
        tick(s, now);
        s.commands = s.commands.filter(
          (c) => c.generation === s.generation || c.status === "inflight",
        );
        const cmd = s.commands[0];
        const motionDue =
          cmd?.kind === "motion" && s.serviceMotion
            ? s.serviceMotion.nextSampleMs === undefined ||
              this.motionClock.elapsed(s.serviceMotion) >=
                s.serviceMotion.nextSampleMs
            : undefined;
        if (motionDue === false && cmd?.attempts === 0) {
          // Persist a recovery alarm, but keep these <=200ms fences in this
          // dispatch. Alarm delivery latency must not become another black hold.
          this.save(s);
          await this.arm();
          const result = await waitForMotionFence(
            s,
            this.motionClock,
            () => this.load(),
            this.motionFenceWait,
          );
          // No state from before either await is written. Candidate changes,
          // native failures and phase progress all go through a fresh load.
          if (result !== "pending") continue;
          break;
        }
        if (
          !cmd ||
          (cmd.attempts > 0 && cmd.dueAt > now) ||
          (motionDue === undefined ? cmd.dueAt > now : !motionDue)
        ) {
          this.save(s);
          break;
        }
        if (cmd.kind === "motion") {
          const motion = s.serviceMotion;
          if (
            !motion ||
            motion.id !== cmd.motionId ||
            motion.phase === "handoff"
          ) {
            s.commands.shift();
            this.save(s);
            continue;
          }
          const elapsed =
            motion.phase === "black" || motion.nativeStarted
              ? this.motionClock.elapsed(motion)
              : motion.elapsedMs;
          if (motion.phase === "fade" && motion.nativeStarted) {
            if (elapsed < FADE_MS) {
              cmd.dueAt = now + FADE_MS - elapsed;
              this.save(s);
              break;
            }
            // The device has played its local fade independently of HTTP.
            // ACK+duration is a conservative opaque assurance, then black200.
            motion.phase = "black";
            motion.elapsedMs = 0;
            motion.nextSampleMs = BLACK_MS;
            this.motionClock.reset();
            this.motionClock.elapsed(motion);
            cmd.dueAt = now + BLACK_MS;
            this.save(s);
            continue;
          }
          if (motion.phase === "black") {
            if (elapsed < BLACK_MS) {
              cmd.dueAt = now + BLACK_MS - elapsed;
              this.save(s);
              break;
            }
            motion.phase = "handoff";
            s.commands.shift();
            // All scene offsets remain relative to the actual end of black,
            // including after preloads, candidate changes or slow native ACKs.
            const entrance = s.commands.find(
              (c) =>
                c.generation === s.generation &&
                c.kind === "draw" &&
                !c.refresh,
            );
            if (entrance) {
              const delay = now - entrance.dueAt;
              for (const command of s.commands)
                if (
                  command.generation === s.generation &&
                  !command.refresh &&
                  command.kind === "draw"
                )
                  command.dueAt += delay;
            }
            this.save(s);
            continue;
          }
          if (!motion.mode) {
            motion.mode = cacheNativeMotionAssets(s, now)
              ? "native"
              : "fallback";
            if (motion.mode === "fallback")
              this.traceDisplay("motion_fallback", {
                generation: s.generation,
                reason: "asset_cache",
                ...nativeMotionCapacity(s, pinnedSlots(s)),
              });
          }
          cmd.elements =
            motion.mode === "native"
              ? nativeMotionElements(motion.id)
              : motionElements(100);
        }
        if (cmd.kind === "clear" && cmd.elementIds) {
          // tick has removed ACKed widgets whose finite device TTL has ended.
          // Retrying their IDs can fail forever after the namespace disappears.
          // Unknown draws go through recovery above; never widen this deletion.
          const retained = cmd.elementIds.filter((id) => s.nativeElements[id]);
          if (retained.length < cmd.elementIds.length)
            this.traceDisplay("retirement_expired", {
              generation: cmd.generation,
              elementCount: cmd.elementIds.length - retained.length,
            });
          cmd.elementIds = retained;
        }
        if (cmd.kind === "draw" && cmd.handoff && visibleHandoff(s)) {
          // A late old-generation incoming ACK may only now prove that its
          // unmask made content visible. Give that view its own bounded exit;
          // an opaque handoff still keeps the existing deadline unchanged.
          s.serviceMotion = {
            id: s.commandSeq + 1,
            phase: "fade",
            elapsedMs: 0,
          };
          enqueue(s, {
            generation: s.generation,
            kind: "motion",
            dueAt: now,
            motionId: s.serviceMotion.id,
          });
          s.commands.unshift(s.commands.pop()!);
          this.save(s);
          continue;
        }
        // Reserve all assets for the generation before any draw. Playing/pending slots stay pinned.
        if (cmd.kind === "draw" || cmd.kind === "motion") {
          const incomingElements =
            (cmd.handoff || cmd.kind === "motion") && s.selected
              ? s.items[s.selected].scene.commands.flatMap((c) => c.elements)
              : cmd.kind === "motion"
                ? []
                : (cmd.elements ?? []);
          const priorSlots = structuredClone(s.slots);
          if (cmd.kind === "draw" && cmd.prepared === "pending") {
            const assets = preparedBlackAssets();
            if (!cacheInternalAssets(s, now, assets))
              this.preparedFallback(s, cmd, "asset_cache");
            else if (!reuseNativeMotionSlots(s, pinnedSlots(s), assets))
              this.preparedFallback(s, cmd, "animation_slots");
            else cmd.preparedAssetHashes = assets.map((a) => a.hash);
          }
          if (
            cmd.kind === "motion" &&
            s.serviceMotion?.mode === "native" &&
            !reuseNativeMotionSlots(s, pinnedSlots(s))
          ) {
            this.traceDisplay("motion_fallback", {
              generation: s.generation,
              reason: "animation_slots",
              ...nativeMotionCapacity(s, pinnedSlots(s)),
            });
            s.serviceMotion.mode = "fallback";
            cmd.elements = motionElements(100);
          }
          const hashes = [
            ...incomingElements,
            ...(cmd.kind === "motion" ? (cmd.elements ?? []) : []),
          ].flatMap((e) => (e.assetHash ? [e.assetHash] : []));
          hashes.push(...(cmd.preparedAssetHashes ?? []));
          let slots: Slot[];
          try {
            const union = new Set([
              ...Object.keys(s.nativeElements),
              ...(cmd.elements ?? []).map((e) => e.id),
              ...(cmd.prepared === "pending"
                ? preparedBlackElements(s.generation).map((e) => e.id)
                : []),
            ]);
            if (
              cmd.handoff &&
              union.size > (cmd.prepared ? PREPARED_NATIVE_ELEMENT_LIMIT : 128)
            )
              throw new ProtocolError("NATIVE_ELEMENT_CAPACITY", 413);
            slots = reserveSlots(s, hashes, pinnedSlots(s), now);
          } catch (error) {
            s.slots = priorSlots;
            if (
              cmd.prepared === "pending" &&
              error instanceof ProtocolError &&
              [
                "SLOT_CAPACITY",
                "SLOT_BYTES_CAPACITY",
                "NATIVE_ELEMENT_CAPACITY",
              ].includes(error.code)
            ) {
              this.preparedFallback(
                s,
                cmd,
                error.code === "SLOT_CAPACITY"
                  ? "incoming_slot_count"
                  : error.code === "SLOT_BYTES_CAPACITY"
                    ? "incoming_slot_bytes"
                    : "prepared_native_capacity",
              );
              this.save(s);
              continue;
            }
            if (
              cmd.prepared === "fallback" &&
              error instanceof ProtocolError &&
              [
                "SLOT_CAPACITY",
                "SLOT_BYTES_CAPACITY",
                "NATIVE_ELEMENT_CAPACITY",
              ].includes(error.code)
            ) {
              // A prepared generation must never reclaim the old file-backed
              // view and then wait for uploads. Keep it intact and retry within
              // the existing bounded schedule; no incoming proof is granted.
              this.preparedFallback(
                s,
                cmd,
                error.code === "SLOT_CAPACITY"
                  ? "incoming_slot_count"
                  : error.code === "SLOT_BYTES_CAPACITY"
                    ? "incoming_slot_bytes"
                    : "prepared_native_capacity",
              );
              if (this.retireOrphanedLegacyMasks(s, cmd, now)) {
                this.save(s);
                continue;
              }
              cmd.attempts++;
              cmd.dueAt =
                now + Math.min(60000, 1000 * 2 ** Math.min(cmd.attempts, 6));
              s.health.status = "blocked";
              s.health.confirmedValidUntil = 0;
              this.save(s);
              break;
            }
            if (
              cmd.kind === "motion" &&
              error instanceof ProtocolError &&
              ["SLOT_CAPACITY", "SLOT_BYTES_CAPACITY"].includes(error.code)
            ) {
              // A generation too large to coexist with the outgoing slots will
              // use one static opaque draw, then black200 and existing bounded
              // reclamation. Do not fake a fade through repeated HTTP draws.
              this.traceDisplay("motion_fallback", {
                generation: s.generation,
                reason:
                  error.code === "SLOT_CAPACITY"
                    ? "incoming_slot_count"
                    : "incoming_slot_bytes",
                ...nativeMotionCapacity(s, pinnedSlots(s)),
              });
              s.serviceMotion!.mode = "fallback";
              cmd.elements = motionElements(100);
              slots = [];
            } else if (
              cmd.handoff &&
              !cmd.handoffReclaimed &&
              Object.keys(s.nativeElements).length &&
              error instanceof ProtocolError &&
              [
                "SLOT_CAPACITY",
                "SLOT_BYTES_CAPACITY",
                "NATIVE_ELEMENT_CAPACITY",
              ].includes(error.code)
            ) {
              // A large pair cannot coexist. Retire through an acknowledged
              // anchor rather than exposing calendar or overwriting live slots.
              this.reclaimHandoff(
                s,
                cmd,
                now,
                error.code === "NATIVE_ELEMENT_CAPACITY",
              );
              this.save(s);
              continue;
            } else throw error;
          }
          // Mode can change from two native widgets to five inline fallback
          // masks above. Capacity must use that final set, after both fallback
          // decisions and before any upload or draw is dispatched.
          if (cmd.kind === "motion") {
            // Very crowded legacy scenes may have occupied all 128 native IDs.
            // Free only the few IDs needed for masks, retaining the application.
            const union = new Set([
              ...Object.keys(s.nativeElements),
              ...(cmd.elements ?? []).map((e) => e.id),
            ]);
            if (union.size > 128) {
              const retired = Object.keys(s.nativeElements)
                // Prefer already transparent masks from a completed visible
                // handoff; never accumulate per-exit IDs beyond native capacity.
                .sort(
                  (a, b) =>
                    Number(
                      isMotionElement(b) && s.nativeElements[b].opacity === 0,
                    ) -
                    Number(
                      isMotionElement(a) && s.nativeElements[a].opacity === 0,
                    ),
                )
                .filter(
                  (id) =>
                    !isMotionElement(id) || s.nativeElements[id].opacity === 0,
                )
                .slice(0, union.size - 128);
              enqueue(s, {
                generation: s.generation,
                kind: "clear",
                dueAt: now,
                elementIds: retired,
                refresh: true,
              });
              s.commands.unshift(s.commands.pop()!);
              this.save(s);
              continue;
            }
          }
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
        if (cmd.kind === "draw" && cmd.handoff) {
          this.prepareHandoff(s, cmd, now);
          this.save(s);
          continue;
        }
        cmd.status = "inflight";
        cmd.startedAt = now;
        cmd.attempts++;
        this.save(s);
        await this.arm();
        let failed: unknown = null;
        let drawExpiresAt: number | undefined;
        let drawSentAt: number | undefined;
        let requestMs = 0,
          preRequestMs = 0;
        const stage =
          cmd.kind === "upload"
            ? ("prepare" as const)
            : cmd.kind === "clear"
              ? ("retire" as const)
              : cmd.prepared === "commit" || !cmd.refresh
                ? ("commit" as const)
                : ("prepare" as const);
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
          const request = async (
            ...args: Parameters<BusyClient["request"]>
          ) => {
            const startedAt = Date.now();
            preRequestMs = Math.max(0, startedAt - now);
            try {
              return await client.request(...args);
            } finally {
              requestMs += Math.max(0, Date.now() - startedAt);
            }
          };
          if (cmd.kind === "clear" && cmd.elementIds?.length !== 0) {
            this.traceDisplay("clear", {
              generation: cmd.generation,
              scope: cmd.elementIds ? "selective" : "full",
              elementCount: cmd.elementIds?.length ?? null,
              hasNextScene: !!s.selected,
            });
            await request(
              "DELETE",
              "/display/draw?application_name=" + NAMESPACE,
              cmd.elementIds
                ? { application_name: NAMESPACE, element_ids: cmd.elementIds }
                : undefined,
            );
          } else if (cmd.kind === "clear") {
            // All targets expired. No write and no device ACK are fabricated.
          } else if (cmd.kind === "upload") {
            const slot = s.slots.find(
              (v) => v.slot === cmd.slot && v.hash === cmd.hash,
            );
            requireThat(
              slot && cmd.hash && s.assets[cmd.hash],
              "ASSET_MISSING",
              409,
            );
            await request(
              "POST",
              `/assets/upload?application_name=${NAMESPACE}&file=slot-${slot.slot}.${slot.type}`,
              unbase64(s.assets[cmd.hash].data),
            );
          } else {
            const current = s.selected ? s.items[s.selected] : null;
            requireThat(current || cmd.kind === "motion", "STALE_TARGET", 409);
            const remaining = current?.remainingMs ?? 60000;
            const ttl = Math.max(
              1,
              Math.min(
                60,
                Math.ceil(
                  (remaining + (current?.scene.entryDurationMs ?? 0) + 3000) /
                    1000,
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
            await request("POST", "/display/draw", {
              application_name: NAMESPACE,
              priority: NATIVE_PRIORITY,
              ...(current?.scene.ledColor && cmd.kind !== "motion"
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
          // The device may have applied a request whose response was lost. Its
          // unknown widgets cannot be safely retired from the ACK inventory.
          if (
            drawSentAt !== undefined &&
            (!(failed instanceof ProtocolError) ||
              [
                "UPSTREAM_FAILURE",
                "UPSTREAM_UNAVAILABLE",
                "UPSTREAM_INVALID_RESPONSE",
              ].includes(failed.code))
          )
            live.nativeRecoveryRequired = true;
          this.traceDisplay("command_failed", {
            generation: cmd.generation,
            command: cmd.kind,
            elapsedMs: Date.now() - now,
            requestMs,
            preRequestMs,
            stage,
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
        const acceptedAt = Date.now();
        if (cmd.prepared === "commit" && cmd.refreshBatch !== undefined) {
          // Reveal is local to the animation. Keep retirement HTTP out of its
          // black interval even when the commit acknowledgement is immediate.
          for (const retirement of live.commands)
            if (
              retirement.generation === cmd.generation &&
              retirement.kind === "clear" &&
              retirement.refreshBatch === cmd.refreshBatch &&
              retirement.status === "pending"
            )
              retirement.dueAt = Math.max(
                retirement.dueAt,
                acceptedAt + PREPARED_BLACK_MS,
              );
        }
        if (
          (!cmd.refresh || cmd.kind !== "draw") &&
          !(cmd.kind === "clear" && cmd.elementIds?.length === 0)
        )
          this.traceDisplay("command_ack", {
            generation: cmd.generation,
            command: cmd.kind,
            elapsedMs: acceptedAt - now,
            requestMs,
            preRequestMs,
            stage,
            ...(cmd.kind === "upload"
              ? {
                  filenameType: live.slots.find(
                    (slot) => slot.slot === cmd.slot && slot.hash === cmd.hash,
                  )?.type,
                  assetType: cmd.hash ? live.assets[cmd.hash]?.type : undefined,
                }
              : {}),
            elementCount:
              cmd.elements?.length ?? cmd.elementIds?.length ?? null,
          });
        if (
          (cmd.kind === "draw" || cmd.kind === "motion") &&
          drawExpiresAt !== undefined &&
          drawSentAt !== undefined
        )
          for (const element of cmd.elements ?? []) {
            live.elementExpiries[element.id] = {
              type: element.type,
              expiresAt:
                element.type === "text" ? drawExpiresAt : drawSentAt + 60000,
            };
            live.nativeElements[element.id] = element;
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
          cmd.kind === "motion" &&
          live.serviceMotion &&
          live.serviceMotion.id === cmd.motionId
        ) {
          const motion = live.serviceMotion;
          const native = motion.mode === "native";
          motion.nativeStarted = native;
          motion.phase = native ? "fade" : "black";
          motion.elapsedMs = 0;
          this.motionClock.reset();
          this.motionClock.elapsed(motion);
          motion.nextSampleMs = native ? FADE_MS : BLACK_MS;
          const pending = live.commands.find(
            (c) =>
              c.kind === "motion" &&
              c.motionId === motion.id &&
              c.generation === live.generation,
          );
          const dueAt = acceptedAt + (native ? FADE_MS : BLACK_MS);
          if (pending) pending.dueAt = dueAt;
          else
            enqueue(live, {
              generation: live.generation,
              kind: "motion",
              dueAt,
              motionId: motion.id,
            });
          // Keep the motion ahead of the queued entrance after a late old-
          // generation ACK, without ever granting display/admission proof.
          const index = live.commands.findIndex(
            (c) => c.kind === "motion" && c.motionId === motion.id,
          );
          if (index > 0)
            live.commands.unshift(...live.commands.splice(index, 1));
        }
        if (
          live.serviceMotion?.phase === "handoff" &&
          !Object.keys(live.nativeElements).some(isMotionElement)
        ) {
          delete live.serviceMotion;
          this.motionClock.reset();
        }
        if (cmd.generation === live.generation) {
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
      if (path === "/api/computers/enroll" && request.method === "POST") {
        const ticket =
          /^Bearer enroll\.([a-f0-9]{64})\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{40,64})$/.exec(
            bearer ?? "",
          );
        requireThat(ticket && !cookie, "ENROLLMENT_INVALID", 403);
        const secret = text(body.managementSecret, 64);
        requireThat(
          /^[A-Za-z0-9_-]{40,64}$/.test(secret),
          "INVALID_COMPUTER_CREDENTIAL",
        );
        return await env.DEVICES.getByName(ticket[1]).enroll(
          await digest(ticket[3]),
          identifier(ticket[2]),
          await digest(secret),
        );
      }
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
          expiresAt = Date.now() + BROWSER_SESSION_SECONDS * 1000;
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
          "Set-Cookie": `busy_session=${encodeURIComponent(signed)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${BROWSER_SESSION_SECONDS}`,
        });
      }
      let deviceId: string, auth: Auth;
      if (bearer) {
        const computer =
          /^Bearer ([a-f0-9]{64})\.c\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{40,64})$/.exec(
            bearer,
          );
        const match =
          /^Bearer ([a-f0-9]{64})\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{40,64})$/.exec(
            bearer,
          );
        requireThat(computer || match, "UNAUTHORIZED", 401);
        if (computer) {
          deviceId = computer[1];
          const target =
            request.headers.get("X-Busy-Service") ?? body.serviceId;
          auth = {
            kind: "computer",
            computerId: identifier(computer[2]),
            hash: await digest(computer[3]),
            ...(target === undefined || target === null
              ? {}
              : { serviceId: identifier(target) }),
          };
        } else {
          deviceId = match![1];
          requireThat(
            !request.headers.has("X-Busy-Service") ||
              request.headers.get("X-Busy-Service") === match![2],
            "SERVICE_TARGET_MISMATCH",
            403,
          );
          auth = {
            kind: "publisher",
            serviceId: match![2],
            hash: await digest(match![3]),
          };
        }
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
