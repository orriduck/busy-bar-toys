import { DeviceControl } from "../src/index";
import { StateStore } from "../src/store";
import { env, exports } from "cloudflare:workers";
import {
  runInDurableObject,
  runDurableObjectAlarm,
  evictDurableObject,
} from "cloudflare:test";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { State } from "../src/model";
let calls: {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}[] = [];
let blocked = false;
beforeEach(() => {
  calls = [];
  blocked = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const r = input instanceof Request ? input : new Request(input);
    const path = new URL(r.url).pathname;
    if (path === "/busybar/status")
      return Response.json({ device: { serial_number: crypto.randomUUID() } });
    calls.push({
      method: r.method,
      path,
      body:
        r.method === "POST" && path.includes("draw")
          ? ((await r.json()) as Record<string, unknown>)
          : null,
    });
    return Response.json({ ok: true }, { status: blocked ? 409 : 200 });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function drain(promise: Promise<Response>) {
  const response = await promise;
  const bytes = await response.arrayBuffer();
  return new Response(bytes, {
    status: response.status,
    headers: response.headers,
  });
}
async function setup() {
  const login = await exports.default.fetch(
    "https://control.test/api/session",
    {
      method: "POST",
      headers: {
        Origin: "https://control.test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: "fake" }),
    },
  );
  expect(login.status).toBe(200);
  const { deviceId } = (await login.json()) as { deviceId: string };
  const cookie = login.headers.get("Set-Cookie")!.split(";")[0];
  const admin = (path: string, body?: unknown) =>
    drain(
      exports.default.fetch("https://control.test/api" + path, {
        method: body ? "POST" : "GET",
        headers: {
          cookie,
          "X-Busy-Device": deviceId,
          Origin: "https://control.test",
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const registration = await admin("/services", {
    id: "test",
    name: "Test",
    template: "notifier",
    expectedRevision: 0,
  });
  const { credential, epoch } = (await registration.json()) as {
    credential: string;
    epoch: string;
  };
  const send = (path: string, body?: unknown) =>
    drain(
      exports.default.fetch("https://control.test/api" + path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: "Bearer " + credential,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  return { deviceId, cookie, epoch, send, admin };
}
const presentation = (epoch: string, id = "one") => ({
  epoch,
  instanceId: "mac",
  itemId: id,
  version: 1,
  kind: "event",
  level: "info",
  title: "Hello",
  validUntil: Date.now() + 60000,
  scene: {
    entryDurationMs: 0,
    commands: [
      {
        offsetMs: 0,
        elements: [{ id: "text", type: "text", text: "Hello", font: "small" }],
      },
    ],
  },
});
async function displayed(admin: (path: string) => Promise<Response>) {
  for (let j = 0; j < 50; j++) {
    const response = await admin("/snapshot");
    const s = (await response.json()) as { displaying: unknown };
    if (s.displaying) return s;
  }
  throw new Error("did not display");
}
describe("durable device dispatcher", () => {
  it("acknowledges API before displaying, finite text not resent on heartbeat or renewal alarm", async () => {
    const { send, admin, epoch, deviceId } = await setup();
    expect((await send("/publish", presentation(epoch))).status).toBe(200);
    await displayed(admin);
    const first = calls.filter((c) => c.body).length;
    expect(first).toBe(1);
    await send("/heartbeat", {
      epoch,
      instanceId: "mac",
      itemIds: ["one"],
      validUntil: Date.now() + 60000,
    });
    const stub = env.DEVICES.getByName(deviceId);
    await runInDurableObject(stub, (_instance, state) => {
      const store = new StateStore(state.storage);
      const s = store.load()!;
      s.nextTextAt = Date.now() - 1;
      store.save(s);
    });
    await runDurableObjectAlarm(stub);
    expect(calls.filter((c) => c.body).length).toBe(first);
    const elements = calls.find((c) => c.body)!.body!.elements as {
      timeout: number;
    }[];
    expect(elements[0].timeout).toBeGreaterThan(10);
    expect(elements[0].timeout).toBeLessThanOrEqual(60);
  });
  it("409 remains blocked without fabricated display confirmation and durable alarm retries", async () => {
    const { send, admin, epoch, deviceId } = await setup();
    blocked = true;
    await send("/publish", presentation(epoch));
    for (let j = 0; j < 20; j++) await admin("/snapshot");
    const snap = (await (await admin("/snapshot")).json()) as {
      health: { status: string };
      displaying: unknown;
    };
    expect(snap.health.status).toBe("blocked");
    expect(snap.displaying).toBeNull();
    const stub = env.DEVICES.getByName(deviceId);
    const stored = await runInDurableObject(stub, (_instance, state) =>
      new StateStore(state.storage).load()!,
    );
    expect(stored.commands[0].attempts).toBeGreaterThan(0);
    expect(stored.commands[0].status).toBe("pending");
    expect(stored.commands[0].dueAt).toBeGreaterThan(Date.now());
  });
  it("SQLite survives actual eviction without resending acknowledged text", async () => {
    const { send, admin, epoch, deviceId } = await setup();
    await send("/publish", presentation(epoch));
    await displayed(admin);
    const before = calls.filter((c) => c.body).length;
    const stub = env.DEVICES.getByName(deviceId);
    await evictDurableObject(stub);
    const response = await admin("/snapshot");
    expect(
      ((await response.json()) as { items: unknown[] }).items,
    ).toHaveLength(1);
    expect(calls.filter((c) => c.body).length).toBe(before);
  });
});
describe("generation races and content revisions", () => {
  it("heartbeat and same-content version publish never restart short native scrolling", async () => {
    const { send, admin, epoch } = await setup();
    await send("/publish", presentation(epoch));
    await displayed(admin);
    const before = calls.filter((c) => c.body).length;
    const update = {
      ...presentation(epoch),
      version: 2,
      title: "Queue metadata changes",
    };
    expect((await send("/publish", update)).status).toBe(200);
    for (let j = 0; j < 10; j++) await admin("/snapshot");
    expect(calls.filter((c) => c.body).length).toBe(before);
  });
  it("native element type transitions selectively clear only platform element before replacement", async () => {
    const { send, admin, epoch } = await setup();
    await send("/publish", presentation(epoch));
    const snap = (await displayed(admin)) as unknown as { generation: number };
    const result = await send("/update", {
      epoch,
      instanceId: "mac",
      itemId: "one",
      version: 2,
      generation: snap.generation,
      elements: [{ id: "text", type: "rectangle", width: 10, height: 2 }],
    });
    expect(result.status).toBe(200);
    for (let j = 0; j < 15; j++) await admin("/snapshot");
    const last = calls.filter((c) => c.body).at(-1)!;
    expect((last.body!.elements as { type: string }[])[0].type).toBe(
      "rectangle",
    );
    const clears = calls.filter((c) => c.method === "DELETE");
    expect(clears).toHaveLength(2);
  });
  it("late response cannot confirm old owner and subsequent correction is serialized", async () => {
    const { send, admin, epoch } = await setup();
    let enteredResolve: () => void = () => {},
      release: () => void = () => {};
    const entered = new Promise<void>((resolve) => (enteredResolve = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const r = input instanceof Request ? input : new Request(input),
        path = new URL(r.url).pathname;
      calls.push({
        method: r.method,
        path,
        body:
          r.method === "POST"
            ? ((await r.json()) as Record<string, unknown>)
            : null,
      });
      if (r.method === "POST" && first) {
        first = false;
        enteredResolve();
        await gate;
      }
      return Response.json({ ok: true });
    });
    await send("/publish", presentation(epoch));
    await entered;
    const urgent = { ...presentation(epoch, "two"), level: "urgent" };
    await send("/publish", urgent);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    release();
    const final = (await displayed(admin)) as unknown as {
      selected: string;
      displaying: { itemKey: string; generation: number };
      generation: number;
    };
    expect(final.displaying.itemKey).toContain("two");
    expect(final.displaying.generation).toBe(final.generation);
    expect(calls.map((c) => c.method)).toEqual([
      "DELETE",
      "POST",
      "DELETE",
      "POST",
    ]);
  });
  it("constructor reconstructs uncertain persisted command before clearing and replaying full scene", async () => {
    const { send, admin, epoch, deviceId } = await setup();
    await send("/publish", presentation(epoch));
    const first = (await displayed(admin)) as unknown as { generation: number };
    const stub = env.DEVICES.getByName(deviceId);
    await runInDurableObject(stub, (_instance, state) => {
      const store = new StateStore(state.storage);
      const s = store.load()!;
      s.commands.push({
        id: ++s.commandSeq,
        generation: s.generation,
        kind: "draw",
        status: "inflight",
        attempts: 1,
        dueAt: Date.now(),
        elements: s.items[s.selected!].scene.commands[0].elements,
      });
      store.save(s);
      // Reconstruct synchronously: another live dispatcher must not consume the
      // artificially seeded crash marker between setup and constructor replay.
      new DeviceControl(state, env);
    });

    const restored = (await displayed(admin)) as unknown as {
      generation: number;
    };
    expect(restored.generation).toBeGreaterThan(first.generation);
    expect(calls.map((c) => c.method)).toEqual([
      "DELETE",
      "POST",
      "DELETE",
      "POST",
    ]);
  });
});
it("generation-bound update is retry-idempotent and unchanged text never resends", async () => {
  const { send, admin, epoch } = await setup();
  await send("/publish", presentation(epoch));
  const snap = (await displayed(admin)) as { generation?: number };
  const before = calls.filter((c) => c.body).length;
  const b = {
    epoch,
    instanceId: "mac",
    itemId: "one",
    version: 2,
    generation: snap.generation,
    elements: [{ id: "text", type: "text", text: "Hello", font: "small" }],
  };
  expect((await send("/update", b)).status).toBe(200);
  expect((await send("/update", b)).status).toBe(200);
  for (let j = 0; j < 5; j++) await admin("/snapshot");
  expect(calls.filter((c) => c.body).length).toBe(before);
});

describe("renewal bounds", () => {
  it("renews all64 widgets in bounded serialized chunks and confirms only the complete batch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const { send, admin, epoch, deviceId } = await setup();
    const elements = Array.from({ length: 64 }, (_, n) => ({
      id: "widget-" + n,
      type: "rectangle",
      width: 1,
      height: 1,
    }));
    await send("/publish", {
      ...presentation(epoch),
      level: "urgent",
      validUntil: start + 120000,
      scene: {
        entryDurationMs: 0,
        commands: [
          { offsetMs: 0, elements: elements.slice(0, 32) },
          { offsetMs: 0, elements: elements.slice(32) },
        ],
      },
    });
    const initial = (await displayed(admin)) as {
      displaying: { confirmedAt: number; confirmedValidUntil: number };
    };
    let enter: () => void = () => {},
      release: () => void = () => {};
    const entered = new Promise<void>((r) => (enter = r)),
      gate = new Promise<void>((r) => (release = r));
    let renewals = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const body = (await request.json()) as { elements: unknown[] };
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body,
      });
      expect(body.elements.length).toBeLessThanOrEqual(32);
      if (++renewals === 2) {
        enter();
        await gate;
      }
      return Response.json({ ok: true });
    });
    vi.setSystemTime(start + 45000);
    const alarm = runDurableObjectAlarm(env.DEVICES.getByName(deviceId));
    const reached = await Promise.race([
      entered.then(() => true),
      alarm.then(() => false),
    ]);
    if (!reached) {
      release();
      expect(reached).toBe(true);
    }
    const middle = (await (await admin("/snapshot")).json()) as {
      displaying: { confirmedAt: number; confirmedValidUntil: number };
    };
    release();
    await alarm;
    expect(middle.displaying.confirmedAt).toBe(initial.displaying.confirmedAt);
    const final = (await (await admin("/snapshot")).json()) as {
      health: { status: string };
      displaying: { confirmedValidUntil: number };
    };
    expect(renewals).toBe(2);
    expect(final.health.status).toBe("healthy");
    expect(final.displaying.confirmedValidUntil).toBe(start + 105000);
  });
  it("renews finite text before its real expiry when entrance consumed part of cappedTTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const { send, admin, epoch, deviceId } = await setup();
    const stub = env.DEVICES.getByName(deviceId);
    await runInDurableObject(stub, (_instance, ctx) => {
      const store = new StateStore(ctx.storage),
        s = store.load()!;
      s.services.test.config.visibleMs = 55000;
      store.save(s);
    });
    await send("/publish", {
      ...presentation(epoch),
      validUntil: start + 120000,
      scene: {
        entryDurationMs: 10000,
        commands: [
          {
            offsetMs: 0,
            elements: [
              { id: "text", type: "text", text: "Long entry", font: "small" },
            ],
          },
          {
            offsetMs: 10000,
            elements: [
              { id: "widget", type: "rectangle", width: 1, height: 1 },
            ],
          },
        ],
      },
    });
    for (let j = 0; j < 50; j++) {
      await admin("/snapshot");
      const entryAt = await runInDurableObject(
        stub,
        (_instance, ctx) => new StateStore(ctx.storage).load()!.entryAt,
      );
      if (entryAt !== null) {
        expect(entryAt).toBe(start + 10000);
        break;
      }
    }
    vi.setSystemTime(start + 10000);
    await runDurableObjectAlarm(stub);
    await displayed(admin);
    const textCount = () =>
      calls.filter((c) =>
        (c.body?.elements as { type: string }[] | undefined)?.some(
          (e) => e.type === "text",
        ),
      ).length;
    expect(textCount()).toBe(1);
    vi.setSystemTime(start + 45000);
    await runDurableObjectAlarm(stub);
    expect(textCount()).toBe(2);
    const state = await runInDurableObject(stub, (_instance, ctx) =>
      new StateStore(ctx.storage).load()!,
    );
    expect(state.items[state.selected!].remainingMs).toBe(20000);
  });
});
it("does not confirm an expired renewal prefix after a late suffix retry and reconstructs a complete fresh renewal", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  const { send, admin, epoch, deviceId } = await setup();
  const stub = env.DEVICES.getByName(deviceId);
  await runInDurableObject(stub, (_instance, ctx) => {
    const store = new StateStore(ctx.storage),
      s = store.load()!;
    s.services.test.config.heartbeatMs = 300000;
    store.save(s);
  });
  const elements = Array.from({ length: 64 }, (_, n) => ({
    id: "widget-" + n,
    type: "rectangle",
    width: 1,
    height: 1,
  }));
  await send("/publish", {
    ...presentation(epoch),
    level: "urgent",
    validUntil: start + 300000,
    scene: {
      entryDurationMs: 0,
      commands: [
        { offsetMs: 0, elements: elements.slice(0, 32) },
        { offsetMs: 0, elements: elements.slice(32) },
      ],
    },
  });
  await displayed(admin);
  let count = 0;
  vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
    const r = input instanceof Request ? input : new Request(input);
    calls.push({
      method: r.method,
      path: new URL(r.url).pathname,
      body: (await r.json()) as Record<string, unknown>,
    });
    return Response.json({ ok: true }, { status: ++count === 2 ? 409 : 200 });
  });
  vi.setSystemTime(start + 45000);
  await runDurableObjectAlarm(stub);
  expect(
    (
      (await (await admin("/snapshot")).json()) as {
        health: { status: string };
      }
    ).health.status,
  ).toBe("blocked");
  vi.setSystemTime(start + 107000);
  await runDurableObjectAlarm(stub);
  const stale = (await (await admin("/snapshot")).json()) as {
    displaying: unknown;
    health: { status: string };
  };
  expect(stale.displaying).toBeNull();
  expect(stale.health.status).toBe("offline");
  await runDurableObjectAlarm(stub);
  const fresh = (await (await admin("/snapshot")).json()) as {
    displaying: { confirmedValidUntil: number };
    health: { status: string };
  };
  expect(fresh.health.status).toBe("healthy");
  expect(fresh.displaying.confirmedValidUntil).toBe(start + 167000);
  expect(count).toBe(5);
});
it("applies all64 changed full-publish elements in bounded chunks before confirming the new version", async () => {
  const { send, admin, epoch, deviceId } = await setup();
  const scene = (width: number) => {
    const elements = Array.from({ length: 64 }, (_, n) => ({
      id: "widget-" + n,
      type: "rectangle",
      width,
      height: 1,
    }));
    return {
      entryDurationMs: 0,
      commands: [
        { offsetMs: 0, elements: elements.slice(0, 32) },
        { offsetMs: 0, elements: elements.slice(32) },
      ],
    };
  };
  await send("/publish", {
    ...presentation(epoch),
    level: "urgent",
    scene: scene(1),
  });
  await displayed(admin);
  expect(
    (
      await send("/publish", {
        ...presentation(epoch),
        version: 2,
        level: "urgent",
        scene: scene(2),
      })
    ).status,
  ).toBe(200);
  for (let j = 0; j < 50; j++) {
    await admin("/snapshot");
    const pending = await runInDurableObject(
      env.DEVICES.getByName(deviceId),
      (_instance, ctx) => new StateStore(ctx.storage).load()!,
    );
    if (pending.admission[0]?.version === 2 && pending.commands.length === 0)
      break;
  }
  const draws = calls.filter((c) => c.body);
  expect(draws).toHaveLength(4);
  for (const draw of draws.slice(2)) {
    const elements = draw.body!.elements as { width: number }[];
    expect(elements).toHaveLength(32);
    expect(elements.every((e) => e.width === 2)).toBe(true);
  }
  const state = await runInDurableObject(
    env.DEVICES.getByName(deviceId),
    (_instance, ctx) => new StateStore(ctx.storage).load()!,
  );
  expect(state.health.status).toBe("healthy");
  expect(state.admission[0].version).toBe(2);
  expect(state.commands).toHaveLength(0);
});
