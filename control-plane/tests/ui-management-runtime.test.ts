import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { digest, encrypt, signSession } from "../src/security";
import { DeviceControl } from "../src/index";
import { StateStore } from "../src/store";

const origin = "https://control.test";
async function setup() {
  const deviceId = await digest(crypto.randomUUID()),
    id = crypto.randomUUID(),
    expiresAt = Date.now() + 60000;
  const stub = env.DEVICES.getByName(deviceId);
  await stub.login(
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
  const api = (path: string, body: unknown, credential?: string) =>
    exports.default.fetch(origin + path, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(credential
          ? { Authorization: "Bearer " + credential }
          : { cookie, "X-Busy-Device": deviceId }),
      },
      body: JSON.stringify(body),
    });
  let credential = "";
  for (const [index, serviceId] of ["a", "b"].entries()) {
    const result = await api("/api/services", {
      id: serviceId,
      name: serviceId,
      template: "notifier",
      expectedRevision: index,
    });
    expect(result.status).toBe(201);
    credential = ((await result.json()) as { credential: string }).credential;
  }
  const read = () =>
    runInDurableObject(stub, (_instance, ctx) =>
      new StateStore(ctx.storage).load()!,
    );
  return { api, read, credential };
}
describe("management order endpoint", () => {
  it("persists a full order in one config and state revision", async () => {
    const { api, read } = await setup(),
      before = await read();
    const response = await api("/api/services/order", {
      expectedRevision: 2,
      serviceIds: ["b", "a"],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      snapshot: { serverNow: number; configRevision: number; revision: number };
    };
    expect(body.snapshot.configRevision).toBe(3);
    expect(body.snapshot.revision).toBe(before.revision + 1);
    expect(body.snapshot.serverNow).toBeGreaterThan(0);
    const after = await read();
    expect([
      after.services.b.config.priority,
      after.services.a.config.priority,
    ]).toEqual([1000, 999]);
  });
  it("rejects publisher access before mutation", async () => {
    const { api, read, credential } = await setup(),
      before = await read();
    const response = await api(
      "/api/services/order",
      { expectedRevision: 2, serviceIds: ["b", "a"] },
      credential,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "FORBIDDEN" });
    expect(await read()).toEqual(before);
  });
  it("keeps persisted state unchanged for invalid permutations and stale revisions", async () => {
    const { api, read } = await setup(),
      before = await read();
    for (const serviceIds of [
      ["a"],
      ["a", "a"],
      ["a", "unknown"],
      ["a", "b", "unknown"],
    ]) {
      expect(
        (await api("/api/services/order", { expectedRevision: 2, serviceIds }))
          .status,
      ).toBe(400);
      expect(await read()).toEqual(before);
    }
    expect(
      (
        await api("/api/services/order", {
          expectedRevision: 1,
          serviceIds: ["a", "b"],
        })
      ).status,
    ).toBe(409);
    expect(await read()).toEqual(before);
  });
});

describe("computer identity upgrade", () => {
  it("persists legacy grouping on object start and never regenerates it on another start", async () => {
    const deviceId = crypto.randomUUID();
    const stub = env.DEVICES.getByName(deviceId);
    await stub.login(
      deviceId,
      await encrypt("fake", env.TOKEN_ENCRYPTION_KEY),
      "session",
      Date.now() + 60000,
    );
    const state = await runInDurableObject(stub, (_instance, ctx) => {
      const store = new StateStore(ctx.storage);
      const s = store.load()!;
      const base = {
        config: {
          enabled: true,
          allowInput: true,
          allowPreview: true,
          priority: 50,
          visibleMs: 10000,
          snoozeMs: 60000,
          heartbeatMs: 90000,
          exit: "default" as const,
        },
        template: "agent",
        credentialHash: "hash",
        epoch: "epoch",
        epochExpiresAt: Date.now() + 60000,
      };
      s.services = {
        a: { ...base, id: "a", name: "MacBook · Claude" },
        b: { ...base, id: "b", name: "MacBook · Notifier" },
      };
      store.save(s);
      new DeviceControl(ctx, env);
      return new StateStore(ctx.storage).load()!;
    });
    expect(state.services.a.computerId).toMatch(/^[a-f0-9-]{36}$/);
    expect(state.services.b.computerId).toBe(state.services.a.computerId);
    const after = await runInDurableObject(stub, (_instance, ctx) => {
      new DeviceControl(ctx, env);
      return new StateStore(ctx.storage).load()!;
    });
    expect(after).toEqual(state);
  });
  it("allows a manager to register on an existing computer but rejects publishers and foreign IDs", async () => {
    const { api, read, credential } = await setup();
    const before = await read();
    const body = {
      id: "c",
      name: "New service",
      template: "custom",
      computerId: before.services.a.computerId,
      expectedRevision: 2,
    };
    expect((await api("/api/services", body, credential)).status).toBe(403);
    expect(
      (await api("/api/services", { ...body, computerId: crypto.randomUUID() }))
        .status,
    ).toBe(404);
    expect(await read()).toEqual(before);
    expect((await api("/api/services", body)).status).toBe(201);
    const after = await read();
    expect(after.services.c.computerId).toBe(before.services.a.computerId);
  });
});

describe("retired service removal", () => {
  it("removes only the named registration and invalidates its credential", async () => {
    const { api, read, credential } = await setup();
    const before = await read();
    const response = await api("/api/services/b/remove", {
      expectedRevision: 2,
    });
    expect(response.status).toBe(200);
    const after = await read();
    expect(Object.keys(after.services)).toEqual(["a"]);
    expect(after.services.a).toEqual(before.services.a);
    expect(after.configRevision).toBe(3);
    expect(
      (
        await api(
          "/api/heartbeat",
          { instanceId: "mac", itemIds: [] },
          credential,
        )
      ).status,
    ).toBe(401);
  });
  it("rejects publisher removal and stale revisions without mutation", async () => {
    const { api, read, credential } = await setup();
    const before = await read();
    expect(
      (await api("/api/services/a/remove", { expectedRevision: 2 }, credential))
        .status,
    ).toBe(403);
    expect(await read()).toEqual(before);
    expect(
      (await api("/api/services/a/remove", { expectedRevision: 1 })).status,
    ).toBe(409);
    expect(await read()).toEqual(before);
  });
});
