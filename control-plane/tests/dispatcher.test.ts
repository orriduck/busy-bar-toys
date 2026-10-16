import { enrollTestBrowser } from "./helpers/computer";
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
let fixtureToken = "";
const createdDevices = new Set<string>();
let foreignRequests = 0;
function setUpstream(handler: (request: Request) => Promise<Response>) {
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.headers.get("Authorization") !== "Bearer " + fixtureToken) {
      foreignRequests++;
      throw new Error("Unexpected previous fixture request");
    }
    return handler(request);
  });
}
beforeEach(() => {
  calls = [];
  blocked = false;
  foreignRequests = 0;
  fixtureToken = "fixture-" + crypto.randomUUID();
  vi.spyOn(globalThis, "fetch");
  setUpstream(async (input) => {
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
afterEach(async () => {
  // Quiesce every fixture before removing HTTP interception: a previous blocked
  // command's retry alarm must never reach a later recorder or the real network.
  for (const deviceId of createdDevices)
    await runInDurableObject(
      env.DEVICES.getByName(deviceId),
      async (_instance, state) => {
        state.storage.transactionSync(() => {
          for (const table of [
            "control",
            "audit",
            "state_items",
            "state_assets",
            "state_tombstones",
            "state_actions",
            "state_inputs",
            "state_commands",
          ])
            state.storage.sql.exec(`DELETE FROM ${table}`);
        });
        // Clear state synchronously first, so a pending dispatch's finally path
        // cannot read an old command and reinstall an alarm after this delete.
        await state.storage.deleteAlarm();
        expect(await state.storage.getAlarm()).toBeNull();
      },
    );
  createdDevices.clear();
  expect(foreignRequests).toBe(0);
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
      body: JSON.stringify({ token: fixtureToken }),
    },
  );
  expect(login.status).toBe(200);
  const { deviceId } = (await login.json()) as { deviceId: string };
  createdDevices.add(deviceId);
  const cookie = login.headers.get("Set-Cookie")!.split(";")[0];
  await enrollTestBrowser(deviceId, cookie);
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
    const s = (await response.json()) as {
      displaying: unknown;
      generation: number;
    };
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
    setUpstream(async (input) => {
      const r = input instanceof Request ? input : new Request(input),
        path = new URL(r.url).pathname;
      calls.push({
        method: r.method,
        path,
        body: r.body ? ((await r.json()) as Record<string, unknown>) : null,
      });
      if (r.method === "POST" && first) {
        first = false;
        enteredResolve();
        await gate;
      }
      return Response.json({ ok: true });
    });
    const old = presentation(epoch);
    old.scene.commands[0].elements.push({
      id: "old-overlay",
      type: "text",
      text: "Old",
      font: "small",
    });
    await send("/publish", old);
    await entered;
    const urgent = { ...presentation(epoch, "two"), level: "urgent" };
    await send("/publish", urgent);
    await send("/withdraw", {
      epoch,
      instanceId: "mac",
      itemId: "one",
      version: 1,
    });
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
      "POST",
      "DELETE",
    ]);
    expect(calls.at(-1)!.body).toEqual({
      application_name: "busy-control",
      element_ids: ["old-overlay"],
    });
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
    setUpstream(async (input) => {
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
  setUpstream(async (input) => {
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
it("keeps transient fade deltas out of authoritative recovery and dedupes exact-version retries", async () => {
  const { send, admin, epoch, deviceId } = await setup();
  await send("/publish", presentation(epoch));
  const initial = (await displayed(admin)) as { generation: number };
  const clearMask = {
    id: "fade-mask",
    type: "rectangle",
    width: 72,
    height: 16,
    opacity: 0,
  };
  const recovery = {
    entryDurationMs: 0,
    commands: [
      {
        offsetMs: 0,
        elements: [
          { id: "text", type: "text", text: "Hello", font: "small" },
          clearMask,
        ],
      },
    ],
  };
  const body = {
    epoch,
    instanceId: "mac",
    itemId: "one",
    version: 2,
    generation: initial.generation,
    elements: [{ ...clearMask, opacity: 100 }],
    scene: recovery,
  };
  expect((await send("/update", body)).status).toBe(200);
  let saved: State | null = null;
  for (let j = 0; j < 50; j++) {
    await admin("/snapshot");
    saved = await runInDurableObject(
      env.DEVICES.getByName(deviceId),
      (_instance, ctx) => new StateStore(ctx.storage).load(),
    );
    if (saved!.commands.length === 0) break;
  }
  const mask = saved!.items[saved!.selected!].scene.commands[0].elements.find(
    (e) => e.id === "fade-mask",
  );
  expect(mask?.opacity).toBe(0);
  const before = calls.length;
  expect((await send("/update", body)).status).toBe(200);
  expect(calls.length).toBe(before);
  expect(
    (
      await send("/update", {
        ...body,
        scene: { ...recovery, entryDurationMs: 1 },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await send("/update", {
        ...body,
        version: 3,
        scene: {
          entryDurationMs: 0,
          commands: [
            {
              offsetMs: 0,
              elements: [
                { id: "other", type: "image", assetHash: "0".repeat(64) },
              ],
            },
          ],
        },
      })
    ).status,
  ).toBe(403);
  const beforeClear = calls.filter((c) => c.body).length;
  expect(
    (await send("/update", { ...body, version: 3, elements: [clearMask] }))
      .status,
  ).toBe(200);
  for (
    let j = 0;
    j < 50 && calls.filter((c) => c.body).length === beforeClear;
    j++
  )
    await admin("/snapshot");
  expect(calls.filter((c) => c.body).length).toBe(beforeClear + 1);
  expect(
    (
      calls.filter((c) => c.body).at(-1)!.body!.elements as {
        opacity: number;
      }[]
    )[0].opacity,
  ).toBe(0);
  await send("/publish", { ...presentation(epoch, "urgent"), level: "urgent" });
  await send("/end", {
    epoch,
    instanceId: "mac",
    itemId: "urgent",
    version: 1,
  });
  for (let j = 0; j < 50; j++) {
    await admin("/snapshot");
    saved = await runInDurableObject(
      env.DEVICES.getByName(deviceId),
      (_instance, ctx) => new StateStore(ctx.storage).load(),
    );
    if (saved!.commands.length === 0) break;
  }
  const final = calls.filter((c) => c.body).at(-1)!.body!.elements as {
    id: string;
    opacity?: number;
  }[];
  expect(final.find((e) => e.id === "fade-mask")?.opacity).toBe(0);
});
it("pins uploaded transient delta assets through nativeTTL without adding them to recovery", async () => {
  const { send, admin, epoch, deviceId } = await setup();
  const { digest } = await import("../src/security");
  const { pinnedSlots } = await import("../src/assets");
  const hash = await digest("transient-frame");
  expect(
    (
      await send("/assets", {
        hash,
        type: "png",
        data: btoa("transient-frame"),
      })
    ).status,
  ).toBe(200);
  await send("/publish", presentation(epoch));
  const initial = (await displayed(admin)) as { generation: number };
  const recovery = presentation(epoch).scene;
  expect(
    (
      await send("/update", {
        epoch,
        instanceId: "mac",
        itemId: "one",
        version: 2,
        generation: initial.generation,
        elements: [{ id: "transient-frame", type: "image", assetHash: hash }],
        scene: recovery,
      })
    ).status,
  ).toBe(200);
  let state: State | null = null;
  for (let j = 0; j < 50; j++) {
    await admin("/snapshot");
    state = await runInDurableObject(
      env.DEVICES.getByName(deviceId),
      (_instance, ctx) => new StateStore(ctx.storage).load(),
    );
    if (state!.commands.length === 0) break;
  }
  expect(JSON.stringify(state!.items[state!.selected!].scene)).not.toContain(
    hash,
  );
  const slot = state!.slots.find((slot) => slot.hash === hash)!.slot;
  expect(pinnedSlots(state!).has(slot)).toBe(true);
  expect(
    state!.elementExpiries["transient-frame"].expiresAt - Date.now(),
  ).toBeGreaterThan(55000);
  state!.elementExpiries["transient-frame"].expiresAt = Date.now() - 1;
  expect(pinnedSlots(state!).has(slot)).toBe(false);
});
it("full-publish recovery clears a pending transient mask without resending unchanged text", async () => {
  const { send, admin, epoch } = await setup();
  const mask = {
    id: "mask",
    type: "rectangle",
    width: 72,
    height: 16,
    opacity: 0,
  };
  const scene = {
    entryDurationMs: 0,
    commands: [
      {
        offsetMs: 0,
        elements: [...presentation(epoch).scene.commands[0].elements, mask],
      },
    ],
  };
  await send("/publish", { ...presentation(epoch), level: "urgent", scene });
  const initial = (await displayed(admin)) as unknown as { generation: number };
  let enter: () => void = () => {},
    release: () => void = () => {};
  const entered = new Promise<void>((r) => (enter = r)),
    gate = new Promise<void>((r) => (release = r));
  let first = true;
  setUpstream(async (input) => {
    const request = input instanceof Request ? input : new Request(input),
      body = (await request.json()) as Record<string, unknown>;
    calls.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body,
    });
    if (first) {
      first = false;
      enter();
      await gate;
    }
    return Response.json({ ok: true });
  });
  await send("/update", {
    epoch,
    instanceId: "mac",
    itemId: "one",
    version: 2,
    generation: initial.generation,
    elements: [{ ...mask, opacity: 100 }],
    scene,
  });
  await entered;
  expect(
    (
      await send("/publish", {
        ...presentation(epoch),
        version: 3,
        level: "urgent",
        scene,
      })
    ).status,
  ).toBe(200);
  release();
  for (let j = 0; j < 50 && calls.filter((c) => c.body).length < 3; j++)
    await admin("/snapshot");
  const draws = calls.filter((c) => c.body);
  expect(draws).toHaveLength(3);
  expect(draws[2].body!.elements as { id: string; opacity?: number }[]).toEqual(
    [expect.objectContaining({ id: "mask", opacity: 0 })],
  );
  expect(
    draws
      .flatMap((c) => c.body!.elements as { id: string }[])
      .filter((e) => e.id === "text"),
  ).toHaveLength(1);
});
it("advances a clear-only replacement admission only after its selective clear acknowledges", async () => {
  const { send, admin, epoch, deviceId } = await setup();
  const mask = {
    id: "opaque-mask",
    type: "rectangle",
    width: 72,
    height: 16,
    opacity: 100,
  };
  await send("/publish", {
    ...presentation(epoch),
    level: "urgent",
    scene: {
      entryDurationMs: 0,
      commands: [
        {
          offsetMs: 0,
          elements: [...presentation(epoch).scene.commands[0].elements, mask],
        },
      ],
    },
  });
  await displayed(admin);
  let enter: () => void = () => {},
    release: () => void = () => {};
  const entered = new Promise<void>((r) => (enter = r)),
    gate = new Promise<void>((r) => (release = r));
  let fail = true;
  setUpstream(async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    calls.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: null,
    });
    if (fail) {
      enter();
      await gate;
    }
    return Response.json({ ok: true }, { status: fail ? 409 : 200 });
  });
  await send("/publish", {
    ...presentation(epoch),
    version: 2,
    level: "urgent",
  });
  await entered;
  const pending = (await (await admin("/snapshot")).json()) as {
    items: { itemId: string; coverageProof?: { version: number } }[];
  };
  release();
  expect(
    pending.items.find((i) => i.itemId === "one")?.coverageProof,
  ).toBeUndefined();
  const stub = env.DEVICES.getByName(deviceId);
  let state: State | null = null;
  for (let j = 0; j < 50; j++) {
    await admin("/snapshot");
    state = await runInDurableObject(stub, (_instance, ctx) =>
      new StateStore(ctx.storage).load(),
    );
    if (state!.health.status === "blocked") break;
  }
  expect(state!.admission[0].version).toBe(1);
  expect(state!.displaying).toBeNull();
  fail = false;
  await runInDurableObject(stub, (_instance, ctx) => {
    const store = new StateStore(ctx.storage),
      s = store.load()!;
    s.commands[0].dueAt = Date.now();
    store.save(s);
  });
  await runDurableObjectAlarm(stub);
  const accepted = (await (await admin("/snapshot")).json()) as {
    items: { itemId: string; coverageProof?: { version: number } }[];
  };
  expect(
    accepted.items.find((i) => i.itemId === "one")?.coverageProof?.version,
  ).toBe(2);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
});
it("binds an unchanged projected replacement to its still-pending native ACK without redrawing text", async () => {
  const { send, admin, epoch } = await setup();
  const mask = {
    id: "mask",
    type: "rectangle",
    width: 72,
    height: 16,
    opacity: 0,
  };
  const scene = (opacity: number) => ({
    entryDurationMs: 0,
    commands: [
      {
        offsetMs: 0,
        elements: [
          ...presentation(epoch).scene.commands[0].elements,
          { ...mask, opacity },
        ],
      },
    ],
  });
  await send("/publish", {
    ...presentation(epoch),
    level: "urgent",
    scene: scene(0),
  });
  const initial = await displayed(admin);
  let enter: () => void = () => {},
    release: () => void = () => {};
  const entered = new Promise<void>((r) => (enter = r)),
    gate = new Promise<void>((r) => (release = r));
  setUpstream(async (request) => {
    const body = (await request.json()) as Record<string, unknown>;
    calls.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body,
    });
    enter();
    await gate;
    return Response.json({ ok: true });
  });
  await send("/update", {
    epoch,
    instanceId: "mac",
    itemId: "one",
    version: 2,
    generation: initial.generation,
    elements: [{ ...mask, opacity: 100 }],
    scene: scene(100),
  });
  await entered;
  await send("/publish", {
    ...presentation(epoch),
    version: 3,
    level: "urgent",
    scene: scene(100),
  });
  const pending = (await (await admin("/snapshot")).json()) as {
    items: { coverageProof?: { version: number } }[];
  };
  release();
  expect(pending.items[0].coverageProof).toBeUndefined();
  type Accepted = { items: { coverageProof?: { version: number } }[] };
  let accepted: Accepted | null = null;
  for (let j = 0; j < 50; j++) {
    accepted = (await (await admin("/snapshot")).json()) as Accepted;
    if (accepted?.items[0].coverageProof?.version === 3) break;
  }
  expect(accepted?.items[0].coverageProof?.version).toBe(3);
  expect(calls.filter((c) => c.body)).toHaveLength(2);
});

describe("producer withdrawal", () => {
  it("withdraws waiting and displaying occurrences idempotently, fences retries, and stays service scoped", async () => {
    const { send, admin, epoch } = await setup();
    const a = await send("/publish", presentation(epoch, "one"));
    expect(a.status).toBe(200);
    await displayed(admin);
    await send("/publish", presentation(epoch, "two"));
    const body = { epoch, instanceId: "mac", itemId: "two", version: 2 };
    expect((await send("/withdraw", body)).status).toBe(200);
    expect((await send("/withdraw", body)).status).toBe(200);
    let view = (await (await send("/snapshot")).json()) as any;
    expect(view.items.map((i: any) => i.itemId)).toEqual(["one"]);
    expect(
      view.tombstones.find((t: any) => t.itemKey.includes("two")).reason,
    ).toBe("withdrawn");
    expect(
      (await send("/publish", { ...presentation(epoch, "two"), version: 3 }))
        .status,
    ).toBe(409);
    expect(
      (await send("/withdraw", { ...body, serviceId: "foreign" })).status,
    ).toBe(403);
    expect((await send("/withdraw", { ...body, itemId: "one" })).status).toBe(
      200,
    );
    view = await (await admin("/snapshot")).json();
    expect(view.selected).toBeNull();
    // Withdrawal arriving before publish fences delayed network retries too.
    expect((await send("/withdraw", { ...body, itemId: "late" })).status).toBe(
      200,
    );
    expect((await send("/publish", presentation(epoch, "late"))).status).toBe(
      409,
    );
  });
});

it("rotates source turns on a durable alarm after eviction without a producer tick", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { send, admin, epoch, deviceId } = await setup();
  const stub = env.DEVICES.getByName(deviceId),
    start = Date.now();
  await runInDurableObject(stub, async (_instance, ctx) => {
    const { registerService, publish } = await import("../src/model");
    const store = new StateStore(ctx.storage),
      s = store.load()!;
    s.services.test.config.visibleMs = 5000;
    s.services.test.priorityGroup = "dispensable";
    s.computers[s.services.test.computerId!].serviceOrder = ["test"];
    registerService(
      s,
      { id: "peer", name: "Peer", template: "agent" },
      "other-hash",
      "other-epoch",
      start,
    );
    s.services.peer.computerId = "other";
    s.services.peer.config.visibleMs = 7000;
    s.computers.other = {
      id: "other",
      credentialHash: "other-hash",
      createdAt: start,
      serviceOrder: ["peer"],
    };
    // Publish own source first through its real producer route below.
    store.save(s);
  });
  await send("/publish", {
    ...presentation(epoch),
    kind: "agent",
    exit: "source",
  });
  await displayed(admin);
  await runInDurableObject(stub, async (_instance, ctx) => {
    const { publish } = await import("../src/model");
    const store = new StateStore(ctx.storage),
      s = store.load()!;
    publish(
      s,
      "peer",
      { ...presentation("other-epoch", "peer"), kind: "agent", exit: "source" },
      start,
    );
    store.save(s);
  });
  await send("/heartbeat", {
    epoch,
    instanceId: "mac",
    itemIds: ["one"],
    validUntil: start + 60000,
  });
  expect(
    await runInDurableObject(stub, (_i, ctx) => ctx.storage.getAlarm()),
  ).toBe(start + 5000);
  await evictDurableObject(stub);
  vi.setSystemTime(start + 5000);
  await runDurableObjectAlarm(stub);
  await displayed(admin);
  const view = (await (await admin("/snapshot")).json()) as any;
  expect(
    view.items.find((i: any) => i.itemKey === view.selected).serviceId,
  ).toBe("peer");
  expect(view.items).toHaveLength(2);
  expect(view.tombstones).toHaveLength(0);
  vi.setSystemTime(start + 12000);
  await runDurableObjectAlarm(stub);
  await displayed(admin);
  const back = (await (await admin("/snapshot")).json()) as any;
  expect(
    back.items.find((i: any) => i.itemKey === back.selected).serviceId,
  ).toBe("test");
});

it("does not charge a confirmation gap when renewal ACK precedes a late alarm", async () => {
  const { send, admin, epoch, deviceId } = await setup();
  const start = Date.now(),
    stub = env.DEVICES.getByName(deviceId);
  await runInDurableObject(stub, (_instance, ctx) => {
    const store = new StateStore(ctx.storage),
      s = store.load()!;
    s.services.test.priorityGroup = "dispensable";
    store.save(s);
  });
  await send("/publish", {
    ...presentation(epoch),
    kind: "agent",
    exit: "source",
    validUntil: start + 200000,
  });
  await displayed(admin);
  await runInDurableObject(stub, async (instance, ctx) => {
    const { registerService, publish, tick } = await import("../src/model");
    const store = new StateStore(ctx.storage),
      s = store.load()!;
    registerService(
      s,
      { id: "peer", name: "Peer", template: "agent" },
      "hash",
      "peer-epoch",
      start,
    );
    s.services.peer.computerId = "peer";
    s.computers.peer = {
      id: "peer",
      credentialHash: "hash",
      createdAt: start,
      serviceOrder: ["peer"],
    };
    publish(
      s,
      "peer",
      {
        ...presentation("peer-epoch", "peer"),
        kind: "agent",
        exit: "source",
        validUntil: start + 200000,
      },
      start,
    );
    s.serviceTurns.test.remainingMs = 5000;
    s.visibleSince = start + 49000;
    s.displaying!.confirmedValidUntil = start + 50000;
    s.health.confirmedValidUntil = start + 50000;
    // Native response arrives six seconds later. It establishes fresh element
    // expiries, but cannot prove the old screen between seconds50 and55.
    for (const expiry of Object.values(s.elementExpiries))
      expiry.expiresAt = start + 109000;
    s.commands = [];
    (
      instance as unknown as {
        acknowledgeNativeContent: (
          s: State,
          c: State["commands"][number],
          at: number,
        ) => void;
      }
    ).acknowledgeNativeContent(
      s,
      {
        id: 900,
        generation: s.generation,
        kind: "draw",
        dueAt: start + 49000,
        status: "inflight",
        attempts: 1,
        refresh: true,
      },
      start + 55000,
    );
    tick(s, start + 55000);
    expect(s.items[s.selected!].serviceId).toBe("test");
    expect(s.serviceTurns.test.remainingMs).toBe(4000);
    expect(s.visibleSince).toBe(start + 55000);
  });
});

describe("continuous scene handoff", () => {
  it.each(["same-id", "new-id", "new-type"])(
    "keeps the native application populated while handing off %s content",
    async (variant) => {
      const { send, admin, epoch } = await setup();
      await send("/publish", presentation(epoch));
      await displayed(admin);
      const screen = new Map<string, string>([["text", "text"]]);
      const emptyFrames: string[] = [];
      setUpstream(async (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/display/draw")) {
          const body = request.body
            ? ((await request.json()) as Record<string, unknown>)
            : null;
          if (request.method === "DELETE") {
            if (Array.isArray(body?.element_ids))
              for (const id of body.element_ids) screen.delete(String(id));
            else screen.clear();
          } else {
            for (const e of body!.elements as { id: string; type: string }[]) {
              if (screen.has(e.id) && screen.get(e.id) !== e.type)
                return Response.json(
                  { error: "type must be cleared first" },
                  { status: 400 },
                );
              screen.set(e.id, e.type);
            }
          }
          if (!screen.size) emptyFrames.push(request.method);
        }
        return Response.json({ ok: true });
      });
      const next = presentation(epoch, "two");
      next.scene.commands[0].elements =
        variant === "new-type"
          ? ([{ id: "text", type: "rectangle", width: 10, height: 2 }] as never)
          : [
              {
                id: variant === "same-id" ? "text" : "next",
                type: "text",
                text: "Next",
                font: "small",
              },
            ];
      await send("/publish", next);
      await send("/withdraw", {
        epoch,
        instanceId: "mac",
        itemId: "one",
        version: 1,
      });
      const settled = (await displayed(admin)) as {
        displaying: { itemKey: string };
      };
      expect(settled.displaying.itemKey).toContain("two");
      expect(emptyFrames).toEqual([]);
      expect([...screen.keys()]).toEqual([
        variant === "new-id" ? "next" : "text",
      ]);
      await send("/withdraw", {
        epoch,
        instanceId: "mac",
        itemId: "two",
        version: 1,
      });
      for (let j = 0; j < 30 && screen.size; j++) await admin("/snapshot");
      expect(screen.size).toBe(0);
    },
  );
});

it("keeps outgoing content and pins while all incoming scene assets upload", async () => {
  const { send, admin, epoch, deviceId } = await setup();
  const { digest } = await import("../src/security");
  const hashes = await Promise.all([digest("first"), digest("later")]);
  for (const [i, hash] of hashes.entries())
    expect(
      (
        await send("/assets", {
          hash,
          type: "png",
          data: btoa(i ? "later" : "first"),
        })
      ).status,
    ).toBe(200);
  await send("/publish", presentation(epoch));
  await displayed(admin);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => (enter = r)),
    gate = new Promise<void>((r) => (release = r));
  const events: string[] = [];
  let waiting = true;
  setUpstream(async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/assets/upload")) {
      events.push("upload");
      if (waiting) {
        waiting = false;
        enter();
        await gate;
      }
    } else events.push(request.method);
    return Response.json({ ok: true });
  });
  await send("/publish", {
    ...presentation(epoch, "two"),
    scene: {
      entryDurationMs: 0,
      commands: hashes.map((hash, i) => ({
        offsetMs: 0,
        elements: [
          { id: i ? "later" : "text", type: "image", assetHash: hash },
        ],
      })),
    },
  });
  await send("/withdraw", {
    epoch,
    instanceId: "mac",
    itemId: "one",
    version: 1,
  });
  await entered;
  try {
    expect(events).toEqual(["upload"]);
    const pending = await runInDurableObject(
      env.DEVICES.getByName(deviceId),
      (_instance, ctx) => new StateStore(ctx.storage).load()!,
    );
    expect(pending.nativeElements.text.type).toBe("text");
    expect(pending.displaying).toBeNull();
  } finally {
    release();
  }
  const final = (await displayed(admin)) as { displaying: { itemKey: string } };
  expect(final.displaying.itemKey).toContain("two");
  expect(events.slice(0, 2)).toEqual(["upload", "upload"]);
});

it("reclaims full asset slots through an anchor without exposing calendar", async () => {
  const { send, admin, epoch, deviceId } = await setup();
  const { digest } = await import("../src/security");
  const hash = await digest("next");
  await send("/assets", { hash, type: "png", data: btoa("next") });
  await send("/publish", presentation(epoch));
  await displayed(admin);
  const stub = env.DEVICES.getByName(deviceId);
  // Mock 16 live asset slots: storage metadata exercises the real allocator.
  await runInDurableObject(stub, (_instance, ctx) => {
    const store = new StateStore(ctx.storage),
      s = store.load()!;
    s.nativeElements = {};
    s.elementExpiries = {};
    s.slots = [];
    for (let i = 0; i < 16; i++) {
      const oldHash = i.toString(16).padStart(64, "0"),
        id = `old-${i}`;
      s.slots.push({
        slot: i,
        hash: oldHash,
        type: "png",
        bytes: 10,
        uploaded: true,
      });
      s.nativeElements[id] = { id, type: "image", assetHash: oldHash };
      s.elementExpiries[id] = { type: "image", expiresAt: Date.now() + 60000 };
    }
    store.save(s);
  });
  const screen = new Set(Array.from({ length: 16 }, (_, i) => `old-${i}`));
  const empty: boolean[] = [];
  let anchorIsOpaqueBlack = false;
  setUpstream(async (request) => {
    if (new URL(request.url).pathname.endsWith("/display/draw")) {
      const body = request.body
        ? ((await request.json()) as {
            elements?: {
              id: string;
              type: string;
              data?: string;
              fill?: string;
              fill_colors?: string[];
              border_width?: number;
            }[];
            element_ids?: string[];
          })
        : null;
      if (request.method === "DELETE") {
        if (body?.element_ids)
          for (const id of body.element_ids) screen.delete(id);
        else screen.clear();
      } else
        for (const e of body!.elements!) {
          screen.add(e.id);
          if (e.id.startsWith("control-handoff-")) {
            if (e.type === "xpmbitmap" && e.data) {
              const lines = e.data.trim().split("\n");
              const [width, height, count, chars] = lines[1]
                .split(" ")
                .map(Number);
              const palette = new Map(
                lines
                  .slice(2, 2 + count)
                  .map((line) => [
                    line.slice(0, chars),
                    line.slice(chars).trim().replace(/^c /, "").toUpperCase(),
                  ]),
              );
              anchorIsOpaqueBlack =
                width === 1 &&
                height === 1 &&
                palette.get(lines[2 + count].slice(0, chars)) === "#000000";
            } else
              anchorIsOpaqueBlack =
                e.type === "rectangle" &&
                e.fill === "solid" &&
                e.fill_colors?.[0] === "#000000FF" &&
                e.border_width === 0;
          }
        }
      if (!screen.size) empty.push(true);
    }
    return Response.json({ ok: true });
  });
  await send("/publish", {
    ...presentation(epoch, "two"),
    scene: {
      entryDurationMs: 0,
      commands: [
        {
          offsetMs: 0,
          elements: [{ id: "next", type: "image", assetHash: hash }],
        },
      ],
    },
  });
  await send("/withdraw", {
    epoch,
    instanceId: "mac",
    itemId: "one",
    version: 1,
  });
  const final = (await displayed(admin)) as { displaying: { itemKey: string } };
  expect(final.displaying.itemKey).toContain("two");
  expect(empty).toEqual([]);
  expect(anchorIsOpaqueBlack).toBe(true);
  expect([...screen]).toEqual(["next"]);
});

it("retires a preempted draw even when its response is lost after the device applied it", async () => {
  const { send, admin, epoch, deviceId } = await setup();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => (enter = r)),
    gate = new Promise<void>((r) => (release = r));
  const screen = new Set<string>();
  let first = true;
  setUpstream(async (request) => {
    const body = request.body
      ? ((await request.json()) as {
          elements?: { id: string }[];
          element_ids?: string[];
        })
      : null;
    if (request.method === "DELETE") {
      if (body?.element_ids)
        for (const id of body.element_ids) screen.delete(id);
      else screen.clear();
    } else {
      for (const e of body!.elements!) screen.add(e.id);
      if (first) {
        first = false;
        enter();
        await gate;
        return Response.json({ error: "reply lost" }, { status: 503 });
      }
    }
    return Response.json({ ok: true });
  });
  const old = presentation(epoch);
  old.scene.commands[0].elements[0].id = "uncertain-overlay";
  await send("/publish", old);
  await entered;
  try {
    await send("/publish", presentation(epoch, "two"));
    await send("/withdraw", {
      epoch,
      instanceId: "mac",
      itemId: "one",
      version: 1,
    });
  } finally {
    release();
  }
  const stub = env.DEVICES.getByName(deviceId);
  for (let j = 0; j < 30; j++) {
    await admin("/snapshot");
    const pending = await runInDurableObject(stub, (_instance, ctx) =>
      new StateStore(ctx.storage).load()!,
    );
    if (pending.nativeRecoveryRequired) break;
  }
  await runInDurableObject(stub, (_instance, ctx) => {
    const store = new StateStore(ctx.storage),
      s = store.load()!;
    expect(s.nativeRecoveryRequired).toBe(true);
    expect(s.commands[0].dueAt).toBeGreaterThan(Date.now());
    s.commands[0].dueAt = Date.now();
    store.save(s);
  });
  await runDurableObjectAlarm(stub);
  const final = (await displayed(admin)) as { displaying: { itemKey: string } };
  expect(final.displaying.itemKey).toContain("two");
  expect([...screen]).toEqual(["text"]);
});

it("retains bounded content-free display diagnostics across eviction for management only", async () => {
  const { send, admin, epoch, deviceId } = await setup();
  await send("/publish", presentation(epoch));
  await displayed(admin);
  expect((await send("/diagnostics/display")).status).toBe(403);
  const response = await admin("/diagnostics/display");
  expect(response.status).toBe(200);
  const diagnostic = (await response.json()) as {
    implementation: string;
    events: { at: number; kind: string; data: Record<string, unknown> }[];
  };
  expect(diagnostic.implementation).toBe("continuous-handoff-v3");
  expect(diagnostic.events.some((e) => e.kind === "command_ack")).toBe(true);
  const serialized = JSON.stringify(diagnostic);
  expect(serialized).not.toContain("Hello");
  expect(serialized).not.toContain(fixtureToken);
  await runInDurableObject(
    env.DEVICES.getByName(deviceId),
    async (instance) => {
      const trace = instance as unknown as {
        traceDisplay(kind: "handoff", data: { generation: number }): void;
      };
      for (let i = 0; i < 140; i++)
        trace.traceDisplay("handoff", { generation: i });
    },
  );
  await evictDurableObject(env.DEVICES.getByName(deviceId));
  const retained = (await (
    await admin("/diagnostics/display")
  ).json()) as typeof diagnostic;
  expect(retained.events).toHaveLength(128);
  expect(retained.events[0].data.generation).toBe(12);
  expect(retained.events.at(-1)!.data.generation).toBe(139);
});
