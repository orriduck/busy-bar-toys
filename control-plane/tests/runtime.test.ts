import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { createState } from "../src/model";
import { digest, encrypt, signSession } from "../src/security";
const origin = "https://control.test";
async function admin() {
  const deviceId = await digest(crypto.randomUUID()),
    id = crypto.randomUUID(),
    expiresAt = Date.now() + 60000;
  await env.DEVICES.getByName(deviceId).login(
    deviceId,
    await encrypt("fake", env.TOKEN_ENCRYPTION_KEY),
    id,
    expiresAt,
  );
  const cookie =
    "busy_session=" +
    encodeURIComponent(
      await signSession({ deviceId, id, expiresAt }, env.SESSION_SIGNING_KEY),
    );
  return { deviceId, cookie };
}
async function api(
  path: string,
  cookie: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  return exports.default.fetch(origin + path, {
    method,
    headers: {
      cookie,
      Origin: origin,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
describe("Worker/SQLite DO runtime", () => {
  it("rejects missing auth, cross-origin cookie writes, and arbitrary proxy paths", async () => {
    expect((await api("/api/snapshot", "")).status).toBe(401);
    const { cookie } = await admin();
    const r = await exports.default.fetch(origin + "/api/services", {
      method: "POST",
      headers: {
        cookie,
        Origin: "https://evil.test",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(r.status).toBe(403);
    expect((await api("/api/proxy/wifi", cookie)).status).toBe(404);
  });
  it("persists independent device config and publisher scope, revokes session", async () => {
    const { cookie } = await admin();
    const second = await admin();
    const registration = await api("/api/services", cookie, {
      id: "a",
      name: "Alpha",
      template: "agent",
      config: {},
      expectedRevision: 0,
    });
    expect(registration.status).toBe(201);
    const result = (await registration.json()) as {
      credential: string;
      epoch: string;
      snapshot: { services: unknown[] };
    };
    expect(result.credential).toContain(".a.");
    expect(result.snapshot.services).toHaveLength(1);
    const view = await api("/api/snapshot", second.cookie);
    expect(
      ((await view.json()) as { services: unknown[] }).services,
    ).toHaveLength(0);
    const publisher = await exports.default.fetch(origin + "/api/snapshot", {
      headers: { Authorization: "Bearer " + result.credential },
    });
    expect(publisher.status).toBe(200);
    const bad = await exports.default.fetch(origin + "/api/services/a", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + result.credential,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expectedRevision: 1, config: { priority: 99 } }),
    });
    expect(bad.status).toBe(403);
    expect(
      (await api("/api/session", cookie, undefined, "DELETE")).status,
    ).toBe(200);
    expect((await api("/api/snapshot", cookie)).status).toBe(401);
  });
  it("SSE always starts with current full snapshot and closes cancelled consumer", async () => {
    const { cookie } = await admin();
    const response = await api("/api/events", cookie);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: snapshot");
    await reader.cancel();
  });
});

describe("publisher liveness and physical input capability", () => {
  it("ordinary publishers cannot submit device-wide physical input but opt-in bridge can", async () => {
    const { cookie } = await admin();
    const reg = await api("/api/services", cookie, {
      id: "bridge",
      name: "Bridge",
      template: "custom",
      config: {},
      expectedRevision: 0,
    });
    const r = (await reg.json()) as { credential: string; epoch: string };
    const send = () =>
      exports.default.fetch(origin + "/api/input", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + r.credential,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          eventId: "button",
          instanceId: "input-listener",
          generation: 0,
          button: "start_pause",
        }),
      });
    expect((await send()).status).toBe(403);
    await api(
      "/api/services/bridge",
      cookie,
      { expectedRevision: 1, config: { allowInput: true } },
      "PATCH",
    );
    expect((await send()).status).toBe(200);
  });
});

it("stores cache larger than2MiB as bounded independent SQLite records", async () => {
  const { deviceId } = await admin();
  const stub = env.DEVICES.getByName(deviceId);
  const { runInDurableObject } = await import("cloudflare:test");
  const { StateStore } = await import("../src/store");
  await runInDurableObject(stub, (_instance, ctx) => {
    const store = new StateStore(ctx.storage),
      state = store.load()!;
    for (let j = 0; j < 10; j++) {
      const hash = String(j).padStart(64, "0");
      state.assets[hash] = {
        hash,
        type: "png",
        data: "A".repeat(262144),
        bytes: 196608,
        owners: ["test"],
        usedAt: Date.now(),
      };
    }
    store.save(state);
    const persisted = new StateStore(ctx.storage).load()!;
    expect(Object.keys(persisted.assets)).toHaveLength(10);
    const max = ctx.storage.sql
      .exec<{ size: number }>(
        "SELECT MAX(length(value)) as size FROM state_assets",
      )
      .one().size;
    expect(max).toBeLessThan(300000);
    const header = ctx.storage.sql
      .exec<{ size: number }>("SELECT length(value) as size FROM control")
      .one().size;
    expect(header).toBeLessThan(10000);
  });
});
