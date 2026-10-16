/** Deterministic v5 state machine. Every operation is persisted atomically by DeviceControl. */
export class ProtocolError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function requireThat(
  value: unknown,
  code = "INVALID_REQUEST",
  status = 400,
): asserts value {
  if (!value) throw new ProtocolError(code, status);
}
export type Level = "urgent" | "attention" | "info";
export type Element = {
  id: string;
  type:
    "text" | "image" | "animation" | "countdown" | "rectangle" | "xpmbitmap";
  assetHash?: string;
  [key: string]: unknown;
};
export interface Scene {
  ledColor?: string;
  entryDurationMs: number;
  commands: { offsetMs: number; elements: Element[] }[];
}
export interface Config {
  enabled: boolean;
  allowInput: boolean;
  allowPreview: boolean;
  priority: number;
  visibleMs: number;
  snoozeMs: number;
  heartbeatMs: number;
  exit: "default" | "finite" | "source";
}
export interface Service {
  id: string;
  name: string;
  template: string;
  config: Config;
  credentialHash: string;
  epoch: string;
  epochExpiresAt: number;
}
export interface Item {
  itemKey: string;
  serviceId: string;
  instanceId: string;
  itemId: string;
  epoch: string;
  version: number;
  kind: "event" | "condition" | "agent";
  level: Level;
  groupKey?: string;
  app?: string;
  title: string;
  detail: string;
  firstRecognizedAt: number;
  timeReliable: boolean;
  receivedAt: number;
  enqueueSeq: number;
  validUntil: number;
  lastHeartbeat: number;
  state:
    "waiting" | "applying" | "displaying" | "preempted" | "paused" | "snoozed";
  remainingMs: number | null;
  /** Initial budget for this playback cycle; absent on legacy persisted items. */
  originalVisibleMs?: number;
  nextEligibleAt: number | null;
  scene: Scene;
  actionKeys: string[];
  businessId?: string;
  lastUpdateFingerprint?: string;
}
export interface Action {
  id: string;
  requestId: string;
  itemKey: string;
  serviceId: string;
  instanceId: string;
  itemId: string;
  version: number;
  generation: number;
  actionKey: string;
  businessId?: string;
  status: "pending" | "running" | "succeeded" | "failed" | "unknown";
  createdAt: number;
  expiresAt: number;
}
export interface Tombstone {
  itemKey: string;
  serviceId: string;
  version: number;
  epoch: string;
  expiresAt: number;
  reason: string;
}
export interface Command {
  id: number;
  generation: number;
  kind: "clear" | "draw" | "upload";
  dueAt: number;
  elements?: Element[];
  hash?: string;
  slot?: number;
  status: "pending" | "inflight";
  attempts: number;
  startedAt?: number;
  refresh?: boolean;
  refreshBatch?: number;
  itemKey?: string;
  itemVersion?: number;
  elementIds?: string[];
}
export interface Asset {
  hash: string;
  type: string;
  data: string;
  bytes: number;
  owners: string[];
  usedAt: number;
}
export interface Slot {
  slot: number;
  hash: string;
  type: string;
  bytes: number;
  uploaded: boolean;
}
export interface State {
  deviceId: string;
  revision: number;
  configRevision: number;
  generation: number;
  seq: number;
  commandSeq: number;
  services: Record<string, Service>;
  items: Record<string, Item>;
  tombstones: Record<string, Tombstone>;
  actions: Record<string, Action>;
  inputs: Record<string, { expiresAt: number }>;
  selected: string | null;
  applying: string | null;
  displaying: {
    itemKey: string;
    generation: number;
    confirmedAt: number;
    confirmedValidUntil: number;
  } | null;
  admission: { itemKey: string; version: number }[];
  visibleSince: number | null;
  entryAt: number | null;
  health: {
    status: "unknown" | "healthy" | "blocked" | "offline";
    confirmedValidUntil: number;
    lastSuccessAt: number | null;
  };
  commands: Command[];
  assets: Record<string, Asset>;
  slots: Slot[];
  tokenCipher?: string;
  sessions: Record<string, number>;
  elementExpiries: Record<string, { type: Element["type"]; expiresAt: number }>;
  nativeElements: Record<string, Element>;
  nextTextAt: number | null;
  nextWidgetAt: number | null;
}
export function createState(deviceId: string): State {
  return {
    deviceId,
    revision: 0,
    configRevision: 0,
    generation: 0,
    seq: 0,
    commandSeq: 0,
    services: {},
    items: {},
    tombstones: {},
    actions: {},
    inputs: {},
    selected: null,
    applying: null,
    displaying: null,
    admission: [],
    visibleSince: null,
    entryAt: null,
    health: { status: "unknown", confirmedValidUntil: 0, lastSuccessAt: null },
    commands: [],
    assets: {},
    slots: [],
    sessions: {},
    elementExpiries: {},
    nativeElements: {},
    nextTextAt: null,
    nextWidgetAt: null,
  };
}
export const defaults: Config = {
  enabled: true,
  allowInput: false,
  allowPreview: false,
  priority: 50,
  visibleMs: 10_000,
  snoozeMs: 1_800_000,
  heartbeatMs: 90_000,
  exit: "default",
};
export function identifier(v: unknown): string {
  requireThat(
    typeof v === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(v) &&
      !["__proto__", "constructor", "prototype"].includes(v),
  );
  return v;
}
export function integer(v: unknown, min: number, max: number): number {
  requireThat(Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max);
  return Number(v);
}
export function text(v: unknown, max: number, optional = false): string {
  if (optional && v === undefined) return "";
  requireThat(
    typeof v === "string" && v.length <= max && (optional || v.length > 0),
  );
  return v;
}
export function record(v: unknown): Record<string, unknown> {
  requireThat(v !== null && typeof v === "object" && !Array.isArray(v));
  return v as Record<string, unknown>;
}
export function validateConfig(v: unknown, base = defaults): Config {
  const x = record(v);
  requireThat(Object.keys(x).every((k) => k in defaults));
  return {
    allowPreview:
      x.allowPreview === undefined
        ? (base.allowPreview ?? false)
        : (requireThat(typeof x.allowPreview === "boolean"), x.allowPreview),
    allowInput:
      x.allowInput === undefined
        ? base.allowInput
        : (requireThat(typeof x.allowInput === "boolean"), x.allowInput),
    enabled:
      x.enabled === undefined
        ? base.enabled
        : (requireThat(typeof x.enabled === "boolean"), x.enabled),
    priority:
      x.priority === undefined ? base.priority : integer(x.priority, 0, 1000),
    visibleMs:
      x.visibleMs === undefined
        ? base.visibleMs
        : integer(x.visibleMs, 1000, 86_400_000),
    snoozeMs:
      x.snoozeMs === undefined
        ? base.snoozeMs
        : integer(x.snoozeMs, 1000, 86_400_000),
    heartbeatMs:
      x.heartbeatMs === undefined
        ? base.heartbeatMs
        : integer(x.heartbeatMs, 5000, 300_000),
    exit:
      x.exit === undefined
        ? base.exit
        : (requireThat(
            x.exit === "default" || x.exit === "finite" || x.exit === "source",
          ),
          x.exit),
  };
}
export function registerService(
  s: State,
  b: Record<string, unknown>,
  hash: string,
  epoch: string,
  now: number,
) {
  const id = identifier(b.id);
  requireThat(!s.services[id], "SERVICE_EXISTS", 409);
  requireThat(Object.keys(s.services).length < 32, "SERVICE_CAPACITY", 413);
  const name = text(b.name, 80);
  requireThat(["agent", "notifier", "custom"].includes(String(b.template)));
  s.services[id] = {
    id,
    name,
    template: String(b.template),
    config: validateConfig(b.config ?? {}),
    credentialHash: hash,
    epoch,
    epochExpiresAt: now + 30 * 86400000,
  };
  s.configRevision++;
  s.revision++;
  return s.services[id];
}
export function patchConfig(
  s: State,
  id: string,
  config: unknown,
  expected: number,
  now: number,
) {
  requireThat(expected === s.configRevision, "CONFIG_CONFLICT", 409);
  requireThat(s.services[id], "SERVICE_NOT_FOUND", 404);
  s.services[id].config = validateConfig(config, s.services[id].config);
  s.configRevision++;
  s.revision++;
  if (!s.services[id].config.enabled)
    for (const i of Object.values(s.items))
      if (i.serviceId === id) end(s, i, "disabled", i.version);
  tick(s, now);
}
export function reorderServices(
  s: State,
  serviceIds: unknown,
  expectedRevision: unknown,
  now: number,
) {
  requireThat(expectedRevision === s.configRevision, "CONFIG_CONFLICT", 409);
  const ids = Object.keys(s.services);
  requireThat(
    Array.isArray(serviceIds) &&
      serviceIds.length === ids.length &&
      new Set(serviceIds).size === ids.length &&
      serviceIds.every(
        (id) => typeof id === "string" && Object.hasOwn(s.services, id),
      ),
    "INVALID_SERVICE_ORDER",
  );
  const revision = s.revision;
  serviceIds.forEach((id, index) => {
    s.services[id].config.priority = 1000 - index;
  });
  s.configRevision++;
  tick(s, now);
  // The complete reorder and its scheduling result form one atomic revision.
  s.revision = revision + 1;
}
const allowed = new Set(
  "id type assetHash x y display align z_index text font color width height scroll_rate scroll_start_delay scroll_repeat_delay opacity loop await_previous_end section timestamp direction show_hours bitmap data".split(
    " ",
  ),
);
export function validateElements(value: unknown): Element[] {
  requireThat(Array.isArray(value) && value.length > 0 && value.length <= 32);
  const ids = new Set<string>();
  return value.map((raw) => {
    const e = record(raw);
    requireThat(
      Object.keys(e).every((k) => allowed.has(k)),
      "ELEMENT_FIELD_NOT_ALLOWED",
    );
    requireThat(
      typeof e.id === "string" &&
        /^[a-zA-Z0-9._-]{1,64}$/.test(e.id) &&
        !ids.has(e.id),
    );
    ids.add(e.id);
    requireThat(
      [
        "text",
        "image",
        "animation",
        "countdown",
        "rectangle",
        "xpmbitmap",
      ].includes(String(e.type)),
    );
    if (e.type === "text") {
      requireThat(
        typeof e.text === "string" && /^[\x20-\x7e]{1,2048}$/.test(e.text),
      );
      requireThat(
        [
          "tiny",
          "small",
          "normal",
          "condensed",
          "bold",
          "large",
          "extra_large",
          "global",
        ].includes(String(e.font)),
      );
    }
    if (e.type === "image" || e.type === "animation")
      requireThat(
        typeof e.assetHash === "string" && /^[a-f0-9]{64}$/.test(e.assetHash),
        "INVALID_ASSET_REFERENCE",
      );
    for (const [k, v] of Object.entries(e)) {
      if (["x", "y"].includes(k)) integer(v, -4096, 4095);
      if (["width", "height"].includes(k)) integer(v, 1, 4096);
      if (
        [
          "scroll_rate",
          "scroll_start_delay",
          "scroll_repeat_delay",
          "z_index",
        ].includes(k)
      )
        integer(v, 0, 2147483647);
      if (k === "opacity") integer(v, 0, 100);
      if (["loop", "await_previous_end"].includes(k))
        requireThat(typeof v === "boolean");
      if (k === "color")
        requireThat(typeof v === "string" && /^#[0-9a-fA-F]{8}$/.test(v));
      if (k === "display") requireThat(v === "front" || v === "back");
      if (k === "align")
        requireThat(
          [
            "top_left",
            "top_mid",
            "top_right",
            "mid_left",
            "center",
            "mid_right",
            "bottom_left",
            "bottom_mid",
            "bottom_right",
          ].includes(String(v)),
        );
      if (k === "section")
        requireThat(typeof v === "string" && /^[\w.-]{1,64}$/.test(v));
    }
    requireThat(JSON.stringify(e).length <= 8192);
    return structuredClone(e) as Element;
  });
}
export function validateScene(v: unknown): Scene {
  const x = record(v);
  const entryDurationMs = integer(x.entryDurationMs, 0, 10_000);
  requireThat(
    Array.isArray(x.commands) &&
      x.commands.length > 0 &&
      x.commands.length <= 32,
  );
  let last = -1,
    total = 0;
  const commands = x.commands.map((raw) => {
    const c = record(raw),
      offsetMs = integer(c.offsetMs, 0, entryDurationMs);
    requireThat(offsetMs >= last);
    last = offsetMs;
    const elements = validateElements(c.elements);
    total += elements.length;
    return { offsetMs, elements };
  });
  requireThat(commands[0].offsetMs === 0 && total <= 64, "INCOMPLETE_SCENE");
  if (x.ledColor !== undefined)
    requireThat(
      typeof x.ledColor === "string" && /^#[0-9a-fA-F]{8}$/.test(x.ledColor),
    );
  return {
    entryDurationMs,
    commands,
    ...(x.ledColor ? { ledColor: String(x.ledColor) } : {}),
  };
}
export function groupId(i: Item) {
  return i.groupKey ? JSON.stringify([i.serviceId, i.groupKey]) : i.itemKey;
}
const rank = (i: Item) =>
  i.level === "urgent" ? 2 : i.level === "attention" ? 1 : 0;
function stable(a: Item, b: Item) {
  return (
    a.firstRecognizedAt - b.firstRecognizedAt || a.enqueueSeq - b.enqueueSeq
  );
}
export function groups(s: State) {
  const by = new Map<string, Item[]>();
  for (const i of Object.values(s.items)) {
    if (i.state === "paused" || i.state === "snoozed") continue;
    const key = groupId(i);
    by.set(key, [...(by.get(key) ?? []), i]);
  }
  return [...by]
    .map(([id, members]) => {
      members.sort((a, b) => rank(b) - rank(a) || stable(a, b));
      return {
        id,
        members,
        representative: members[0],
        urgentTime: members.filter((i) => i.level === "urgent").sort(stable)[0],
      };
    })
    .sort((a, b) => {
      if (a.urgentTime && b.urgentTime)
        return stable(a.urgentTime, b.urgentTime);
      if (!!a.urgentTime !== !!b.urgentTime) return a.urgentTime ? -1 : 1;
      return (
        s.services[b.representative.serviceId].config.priority -
          s.services[a.representative.serviceId].config.priority ||
        stable(a.representative, b.representative)
      );
    });
}
function plainApp(value: unknown): string {
  const app = text(value, 64);
  requireThat(app.trim().length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(app));
  return app;
}
export function publish(
  s: State,
  serviceId: string,
  body: Record<string, unknown>,
  now: number,
) {
  const service = s.services[serviceId];
  requireThat(service && service.config.enabled, "SERVICE_DISABLED", 403);
  requireThat(
    body.epoch === service.epoch && now < service.epochExpiresAt,
    "EPOCH_EXPIRED",
    409,
  );
  const instanceId = identifier(body.instanceId),
    itemId = identifier(body.itemId),
    version = integer(body.version, 1, Number.MAX_SAFE_INTEGER),
    key = JSON.stringify([serviceId, instanceId, itemId]);
  requireThat(!s.tombstones[key], "ITEM_ENDED", 409);
  const old = s.items[key];
  if (old) {
    requireThat(version >= old.version, "STALE_VERSION", 409);
    if (version === old.version) return old;
  }
  requireThat(["event", "condition", "agent"].includes(String(body.kind)));
  requireThat(["urgent", "attention", "info"].includes(String(body.level)));
  const scene = validateScene(body.scene);
  const validUntil = integer(body.validUntil, now + 1, now + 86400000);
  const first = Number(body.firstRecognizedAt),
    reliable = Number.isSafeInteger(first) && Math.abs(first - now) <= 300000;
  const actionKeys = body.actionKeys === undefined ? [] : body.actionKeys;
  requireThat(Array.isArray(actionKeys) && actionKeys.length <= 8);
  actionKeys.forEach(identifier);
  const groupKey =
    body.groupKey === undefined ? undefined : text(body.groupKey, 128);
  const item: Item = {
    itemKey: key,
    serviceId,
    instanceId,
    itemId,
    epoch: service.epoch,
    version,
    kind: body.kind as Item["kind"],
    level: body.level as Level,
    groupKey,
    ...(body.app === undefined ? {} : { app: plainApp(body.app) }),
    title: text(body.title, 256),
    detail: text(body.detail, 2048, true),
    scene,
    actionKeys: actionKeys as string[],
    businessId:
      body.businessId === undefined ? undefined : text(body.businessId, 256),
    firstRecognizedAt: old?.firstRecognizedAt ?? (reliable ? first : now),
    timeReliable: old?.timeReliable ?? reliable,
    receivedAt: old?.receivedAt ?? now,
    enqueueSeq: old?.enqueueSeq ?? s.seq + 1,
    lastHeartbeat: now,
    validUntil,
    state: old?.state ?? "waiting",
    remainingMs: old
      ? old.remainingMs
      : service.config.exit === "source" ||
          (service.config.exit === "default" &&
            (body.level === "urgent" || body.kind === "agent"))
        ? null
        : service.config.visibleMs,
    originalVisibleMs: old
      ? old.originalVisibleMs
      : service.config.exit === "source" ||
          (service.config.exit === "default" &&
            (body.level === "urgent" || body.kind === "agent"))
        ? undefined
        : service.config.visibleMs,
    nextEligibleAt: old?.nextEligibleAt ?? null,
  };
  requireThat(
    Object.keys(s.items).length + (old ? 0 : 1) <= 256 &&
      new TextEncoder().encode(JSON.stringify({ ...s.items, [key]: item }))
        .length <=
        2 * 1024 * 1024,
    "ITEM_CAPACITY",
    413,
  );
  requireThat(
    Object.keys(s.tombstones).length +
      Object.keys(s.items).length +
      (old ? 0 : 1) <=
      4096,
    "TOMBSTONE_CAPACITY",
    413,
  );
  if (!old) s.seq++;
  s.items[key] = item;
  s.revision++;
  tick(s, now);
  return item;
}
export function heartbeat(
  s: State,
  serviceId: string,
  b: Record<string, unknown>,
  now: number,
) {
  const service = s.services[serviceId];
  requireThat(
    service && service.epoch === b.epoch && service.epochExpiresAt > now,
    "EPOCH_EXPIRED",
    409,
  );
  const instanceId = identifier(b.instanceId);
  requireThat(Array.isArray(b.itemIds) && b.itemIds.length <= 256);
  const until = integer(b.validUntil, now + 1, now + 86400000);
  const results = b.itemIds.map((raw) => {
    const key = JSON.stringify([serviceId, instanceId, identifier(raw)]),
      item = s.items[key];
    if (item) {
      item.lastHeartbeat = now;
      item.validUntil = until;
      return { itemKey: key, status: "alive" };
    }
    return { itemKey: key, status: s.tombstones[key] ? "ended" : "missing" };
  });
  s.revision++;
  tick(s, now);
  return results;
}
function end(s: State, i: Item, reason: string, version: number) {
  s.tombstones[i.itemKey] = {
    itemKey: i.itemKey,
    serviceId: i.serviceId,
    epoch: i.epoch,
    expiresAt: s.services[i.serviceId].epochExpiresAt,
    version: Math.max(i.version, version),
    reason,
  };
  delete s.items[i.itemKey];
  s.revision++;
}
export function finishItem(
  s: State,
  key: string,
  reason: string,
  version: number,
  now: number,
) {
  const i = s.items[key];
  if (i) {
    requireThat(version >= i.version, "STALE_VERSION", 409);
    end(s, i, reason, version);
  }
  tick(s, now);
}
export function enqueue(
  s: State,
  command: Omit<Command, "id" | "status" | "attempts">,
) {
  s.commands.push({
    ...command,
    id: ++s.commandSeq,
    status: "pending",
    attempts: 0,
  });
}
function switchTo(s: State, next: Item | null, now: number) {
  const prior = s.selected ? s.items[s.selected] : null;
  if (prior && prior.state !== "paused" && prior.state !== "snoozed")
    prior.state = "preempted";
  s.generation++;
  s.selected = next?.itemKey ?? null;
  s.applying = next?.itemKey ?? null;
  s.displaying = null;
  s.visibleSince = null;
  s.entryAt = null;
  s.elementExpiries = {};
  s.nativeElements = {};
  s.nextTextAt = null;
  s.nextWidgetAt = null;
  s.admission = [];
  s.commands = s.commands.filter((c) => c.status === "inflight");
  enqueue(s, { generation: s.generation, kind: "clear", dueAt: now });
  if (next) {
    next.state = "applying";
    s.admission = Object.values(s.items)
      .filter(
        (i) =>
          groupId(i) === groupId(next) &&
          i.state !== "paused" &&
          i.state !== "snoozed",
      )
      .map((i) => ({ itemKey: i.itemKey, version: i.version }));
    for (const c of next.scene.commands)
      enqueue(s, {
        generation: s.generation,
        kind: "draw",
        dueAt: now + c.offsetMs,
        elements: c.elements,
      });
  }
  s.revision++;
}
export function tick(s: State, now: number) {
  const current = s.selected ? s.items[s.selected] : null;
  if (current && s.visibleSince !== null && now > s.visibleSince) {
    if (current.remainingMs !== null)
      current.remainingMs = Math.max(
        0,
        current.remainingMs - (now - s.visibleSince),
      );
    s.visibleSince = now;
  }
  for (const i of Object.values(s.items)) {
    const service = s.services[i.serviceId];
    if (
      !service?.config.enabled ||
      i.validUntil <= now ||
      i.lastHeartbeat + service.config.heartbeatMs <= now ||
      service.epochExpiresAt <= now
    )
      end(s, i, "expired", i.version);
    else if (
      i.state === "snoozed" &&
      i.nextEligibleAt !== null &&
      i.nextEligibleAt <= now
    ) {
      i.state = "waiting";
      i.nextEligibleAt = null;
      i.remainingMs = service.config.visibleMs;
      i.originalVisibleMs = service.config.visibleMs;
      s.revision++;
    }
  }
  if (
    current &&
    s.items[current.itemKey] &&
    current.remainingMs === 0 &&
    s.visibleSince !== null &&
    now >= s.visibleSince
  ) {
    const admittedRepresentative = s.admission.find(
      (a) => a.itemKey === current.itemKey,
    );
    if (admittedRepresentative?.version !== current.version) {
      // The old visible budget is exhausted, but an unseen revision must not be
      // consumed by an older admission. Replay it once with no new lifetime.
      switchTo(s, current, now);
      return;
    }
    for (const admitted of s.admission) {
      const i = s.items[admitted.itemKey];
      if (!i || i.version !== admitted.version || i.level === "urgent")
        continue;
      if (i.kind === "condition") {
        i.state = "snoozed";
        i.nextEligibleAt = now + s.services[i.serviceId].config.snoozeMs;
        i.remainingMs = s.services[i.serviceId].config.visibleMs;
        i.originalVisibleMs = i.remainingMs;
        s.revision++;
      } else end(s, i, "completed", i.version);
    }
    if (s.items[current.itemKey]?.level === "urgent")
      end(s, current, "completed", current.version);
  }
  for (const id of Object.keys(s.nativeElements))
    if ((s.elementExpiries[id]?.expiresAt ?? 0) <= now) {
      delete s.nativeElements[id];
      delete s.elementExpiries[id];
    }
  const pinnedHashes = new Set<string>(
    Object.values(s.nativeElements).flatMap((e) =>
      e.assetHash ? [e.assetHash] : [],
    ),
  );
  for (const item of Object.values(s.items))
    for (const command of item.scene.commands)
      for (const element of command.elements)
        if (element.assetHash) pinnedHashes.add(element.assetHash);
  for (const command of s.commands) {
    if (command.hash) pinnedHashes.add(command.hash);
    for (const element of command.elements ?? [])
      if (element.assetHash) pinnedHashes.add(element.assetHash);
  }
  for (const [hash, asset] of Object.entries(s.assets))
    if (!pinnedHashes.has(hash) && asset.usedAt + 3600000 <= now)
      delete s.assets[hash];
  for (const [key, t] of Object.entries(s.tombstones))
    if (t.expiresAt <= now) delete s.tombstones[key];
  for (const [key, event] of Object.entries(s.inputs))
    if (event.expiresAt <= now) delete s.inputs[key];
  for (const [key, expiry] of Object.entries(s.sessions))
    if (expiry <= now) delete s.sessions[key];
  for (const [key, a] of Object.entries(s.actions)) {
    if (
      (a.status === "pending" || a.status === "running") &&
      a.expiresAt <= now
    ) {
      a.status = "unknown";
      s.revision++;
    }
    if (a.createdAt + 86400000 <= now) delete s.actions[key];
  }
  const queue = groups(s);
  let candidate = queue[0]?.representative ?? null;
  const active = s.selected ? s.items[s.selected] : null;
  const activeGroup = active
    ? queue.find((g) => g.id === groupId(active))
    : null;
  if (active && activeGroup) {
    if (active.level === "urgent" && activeGroup.urgentTime)
      candidate = activeGroup.representative;
    else if (
      candidate &&
      candidate.level !== "urgent" &&
      s.services[candidate.serviceId].config.priority ===
        s.services[active.serviceId].config.priority
    )
      candidate = activeGroup.representative;
  }
  if ((candidate?.itemKey ?? null) !== s.selected) switchTo(s, candidate, now);
}
export function acceptDisplay(s: State, generation: number, now: number) {
  if (generation !== s.generation || !s.selected) return;
  const i = s.items[s.selected];
  if (!i) return;
  s.health = {
    status: "healthy",
    confirmedValidUntil: now + 60000,
    lastSuccessAt: now,
  };
  s.displaying = {
    itemKey: s.selected,
    generation,
    confirmedAt: now,
    confirmedValidUntil: now + 60000,
  };
  s.applying = null;
  i.state = "displaying";
  s.entryAt = Math.max(s.entryAt ?? now + i.scene.entryDurationMs, now);
  s.visibleSince = s.entryAt;
  s.nextTextAt = now + 45000;
  s.nextWidgetAt = now + 45000;
  s.revision++;
}
export function pauseItem(
  s: State,
  key: string,
  operation: string,
  now: number,
) {
  tick(s, now);
  const item = s.items[key];
  requireThat(item, "ITEM_NOT_FOUND", 404);
  if (operation === "pause") item.state = "paused";
  else if (operation === "resume") {
    requireThat(item.state === "paused", "NOT_PAUSED", 409);
    item.state = "waiting";
  } else if (operation === "end") end(s, item, "cancelled", item.version);
  else throw new ProtocolError("INVALID_OPERATION");
  s.revision++;
  tick(s, now);
}
export function requestAction(
  s: State,
  b: {
    requestId: string;
    itemKey: string;
    generation: number;
    actionKey: string;
  },
  now: number,
) {
  identifier(b.requestId);
  const existing = Object.values(s.actions).find(
    (a) => a.requestId === b.requestId,
  );
  if (existing) {
    requireThat(
      existing.itemKey === b.itemKey && existing.actionKey === b.actionKey,
      "ACTION_CONFLICT",
      409,
    );
    return existing;
  }
  requireThat(Object.keys(s.actions).length < 512, "ACTION_CAPACITY", 413);
  const i = s.items[b.itemKey];
  requireThat(
    i && s.selected === b.itemKey && s.generation === b.generation,
    "STALE_TARGET",
    409,
  );
  requireThat(i.actionKeys.includes(b.actionKey), "ACTION_NOT_ALLOWED", 403);
  requireThat(
    now < i.lastHeartbeat + s.services[i.serviceId].config.heartbeatMs,
    "SOURCE_OFFLINE",
    409,
  );
  const a: Action = {
    id: crypto.randomUUID(),
    requestId: b.requestId,
    itemKey: i.itemKey,
    serviceId: i.serviceId,
    instanceId: i.instanceId,
    itemId: i.itemId,
    version: i.version,
    generation: b.generation,
    actionKey: b.actionKey,
    businessId: i.businessId,
    status: "pending",
    createdAt: now,
    expiresAt: now + 30000,
  };
  s.actions[a.id] = a;
  s.revision++;
  return a;
}
export function actionResult(
  s: State,
  id: string,
  status: Action["status"],
  now: number,
) {
  const a = s.actions[id];
  requireThat(a, "ACTION_NOT_FOUND", 404);
  requireThat(["running", "succeeded", "failed", "unknown"].includes(status));
  if (status === "running")
    requireThat(now < a.expiresAt, "ACTION_EXPIRED", 409);
  if (a.status === status) return a;
  requireThat(
    a.status === "pending" ||
      a.status === "running" ||
      (a.status === "unknown" &&
        (status === "succeeded" || status === "failed")),
    "ACTION_TERMINAL",
    409,
  );
  a.status = status;
  s.revision++;
  const item = s.items[a.itemKey];
  if (
    status === "succeeded" &&
    item?.version === a.version &&
    s.generation === a.generation &&
    s.selected === a.itemKey
  )
    end(s, item, "action-succeeded", item.version);
  tick(s, now);
  return a;
}
export function input(
  s: State,
  eventId: string,
  generation: number,
  now: number,
) {
  identifier(eventId);
  if (s.inputs[eventId]) return { duplicate: true };
  requireThat(generation === s.generation, "STALE_TARGET", 409);
  requireThat(Object.keys(s.inputs).length < 2048, "INPUT_CAPACITY", 413);
  const current = s.selected ? s.items[s.selected] : null;
  s.inputs[eventId] = { expiresAt: now + 86400000 };
  if (current?.level === "urgent" && current.actionKeys.includes("primary")) {
    requestAction(
      s,
      {
        requestId: eventId,
        itemKey: current.itemKey,
        generation,
        actionKey: "primary",
      },
      now,
    );
  } else
    for (const i of Object.values(s.items))
      if (i.level !== "urgent") end(s, i, "cleared", i.version);
  s.revision++;
  tick(s, now);
  return { duplicate: false };
}
export function snapshot(s: State, now: number, serviceId?: string) {
  const queue = groups(s),
    controller = s.selected ? s.items[s.selected] : null;
  let eta = now;
  let unknown = false;
  const estimates = new Map<string, { kind: string; at?: number }>();
  for (const g of queue) {
    estimates.set(
      g.id,
      unknown ? { kind: "await-resolution" } : { kind: "estimate", at: eta },
    );
    if (g.representative.remainingMs === null) unknown = true;
    else
      eta +=
        g.representative.remainingMs + g.representative.scene.entryDurationMs;
  }
  const items = Object.values(s.items)
    .filter((i) => !serviceId || i.serviceId === serviceId)
    .map((i) => {
      const {
        scene,
        epoch,
        businessId,
        lastUpdateFingerprint,
        originalVisibleMs,
        ...publicItem
      } = i;
      const actualDisplay =
        s.selected === i.itemKey &&
        s.displaying?.itemKey === i.itemKey &&
        s.displaying.generation === s.generation &&
        i.state === "displaying" &&
        s.applying === null &&
        s.visibleSince !== null;
      const confirmedUntil = actualDisplay
        ? Math.min(
            s.displaying!.confirmedValidUntil,
            s.health.confirmedValidUntil,
          )
        : 0;
      const elapsed = actualDisplay
        ? Math.max(0, Math.min(now, confirmedUntil) - s.visibleSince!)
        : 0;
      const running =
        actualDisplay &&
        s.health.status === "healthy" &&
        confirmedUntil > now;
      const waiting = i.state !== "displaying" && i.state !== "applying";
      const queueProof =
        waiting &&
        i.level === "urgent" &&
        controller?.level === "urgent" &&
        i.itemKey !== controller.itemKey &&
        s.health.status === "healthy" &&
        s.displaying?.generation === s.generation &&
        s.displaying.confirmedValidUntil > now
          ? {
              revision: s.revision,
              itemKey: i.itemKey,
              controller: {
                itemKey: controller.itemKey,
                generation: s.generation,
              },
              validUntil: s.displaying.confirmedValidUntil,
            }
          : undefined;
      const coverage =
        s.admission.some(
          (a) => a.itemKey === i.itemKey && a.version === i.version,
        ) &&
        s.displaying?.generation === s.generation &&
        s.health.status === "healthy" &&
        s.displaying.confirmedValidUntil > now
          ? {
              revision: s.revision,
              itemKey: i.itemKey,
              version: i.version,
              controller: {
                itemKey: s.displaying.itemKey,
                generation: s.generation,
              },
              validUntil: s.displaying.confirmedValidUntil,
            }
          : undefined;
      return {
        ...publicItem,
        playback: {
          totalMs: i.remainingMs === null ? null : (originalVisibleMs ?? null),
          remainingMs:
            i.remainingMs === null
              ? null
              : Math.max(0, i.remainingMs - elapsed),
          running,
          validUntil: running ? confirmedUntil : 0,
          startsAt: actualDisplay ? s.visibleSince : null,
        },
        source: {
          connected:
            i.lastHeartbeat + s.services[i.serviceId].config.heartbeatMs > now,
          lastHeartbeat: i.lastHeartbeat,
        },
        actionAvailable:
          i.actionKeys.length > 0 &&
          i.lastHeartbeat + s.services[i.serviceId].config.heartbeatMs > now,
        coverageProof: coverage,
        eta:
          i.state === "paused"
            ? { kind: "paused" }
            : i.state === "snoozed"
              ? { kind: "snoozed", at: i.nextEligibleAt }
              : (estimates.get(groupId(i)) ?? { kind: "unknown" }),
        queueProof,
      };
    });
  return {
    protocol: 1,
    serverNow: now,
    deviceId: s.deviceId,
    revision: s.revision,
    configRevision: s.configRevision,
    generation: s.generation,
    health: s.health,
    selected: s.selected,
    applying: s.applying,
    displaying: s.displaying,
    services: Object.values(s.services)
      .filter((v) => !serviceId || v.id === serviceId)
      .map(({ credentialHash, ...v }) => ({
        ...v,
        config: { ...v.config, allowPreview: v.config.allowPreview ?? false },
      })),
    items,
    groups: [
      ...new Set([
        ...queue.map((g) => g.id),
        ...Object.values(s.items).map(groupId),
      ]),
    ]
      .map((id) => {
        const active = queue.find((g) => g.id === id);
        const members = Object.values(s.items).filter((i) => groupId(i) === id);
        members.sort((a, b) => rank(b) - rank(a) || stable(a, b));
        const rep = active?.representative ?? members[0];
        return {
          groupId: id,
          representative: rep.itemKey,
          memberKeys: members.map((i) => i.itemKey),
          level: rep.level,
          order: active ? queue.indexOf(active) : -1,
          serviceId: rep.serviceId,
        };
      })
      .filter((g) => !serviceId || g.serviceId === serviceId),
    actions: Object.values(s.actions).filter(
      (a) => !serviceId || a.serviceId === serviceId,
    ),
    tombstones: Object.values(s.tombstones)
      .filter((t) => !serviceId || t.serviceId === serviceId)
      .map(({ epoch, expiresAt, serviceId, ...v }) => v),
  };
}
