import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { digest, encrypt, signSession } from "../src/security";
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
