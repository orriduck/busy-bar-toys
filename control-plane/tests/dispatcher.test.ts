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
afterEach(() => vi.restoreAllMocks());
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
