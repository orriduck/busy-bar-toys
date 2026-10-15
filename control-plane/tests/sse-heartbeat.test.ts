import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { digest } from "../src/security";
import { StateStore } from "../src/store";

async function fixture() {
  const deviceId = await digest(crypto.randomUUID()),
    id = crypto.randomUUID(),
    expiresAt = Date.now() + 60000,
    stub = env.DEVICES.getByName(deviceId),
    auth = { kind: "session" as const, id, expiresAt };
  await stub.login(deviceId, "", id, expiresAt);
  return { stub, auth };
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("sends bounded idle comments before the Python transport's five-second read timeout", async () => {
  const { stub, auth } = await fixture();
  await runInDurableObject(stub, async (instance) => {
    const response = await instance.handle(auth, "/api/events", "GET"),
      reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "event: snapshot",
      );
      for (let count = 0; count < 2; count++) {
        const next = await Promise.race([
          reader.read(),
          delay(3000).then(() => null),
        ]);
        expect(next).not.toBeNull();
        expect(new TextDecoder().decode(next!.value)).toBe(": heartbeat\n\n");
      }
    } finally {
      await reader.cancel();
    }
  });
}, 10000);

it("reclaims abandoned idle stream capacity at the heartbeat without raising the limit", async () => {
  const { stub, auth } = await fixture();
  await runInDurableObject(stub, async (instance) => {
    const bodies: ReadableStream<Uint8Array>[] = [];
    try {
      for (let count = 0; count < 16; count++) {
        const response = await instance.handle(auth, "/api/events", "GET");
        expect(response.status).toBe(200);
        bodies.push(response.body!);
      }
      const full = await instance.handle(auth, "/api/events", "GET");
      expect(full.status).toBe(429);
      expect(await full.json()).toEqual({ error: "SSE_CAPACITY" });
      await delay(2200);
      const reclaimed = await instance.handle(auth, "/api/events", "GET");
      expect(reclaimed.status).toBe(200);
      bodies.push(reclaimed.body!);
    } finally {
      await Promise.all(bodies.map((body) => body.cancel()));
    }
  });
});

it("checks current session authority during idle heartbeats and releases the stream", async () => {
  const { stub, auth } = await fixture();
  await runInDurableObject(stub, async (instance, ctx) => {
    const response = await instance.handle(auth, "/api/events", "GET"),
      reader = response.body!.getReader();
    try {
      await reader.read();
      const store = new StateStore(ctx.storage),
        state = store.load()!;
      delete state.sessions[auth.id];
      store.save(state);
      const next = await Promise.race([
        reader.read(),
        delay(3000).then(() => null),
      ]);
      expect(next).not.toBeNull();
      expect(next!.done).toBe(true);
    } finally {
      await reader.cancel();
    }
  });
});

it.each(["cancel", "expiry", "revocation", "backpressure"] as const)(
  "cleans up both owned stream timers on %s",
  async (reason) => {
    const { stub, auth } = await fixture();
    await runInDurableObject(stub, async (instance, ctx) => {
      const timeouts = vi.spyOn(globalThis, "setTimeout"),
        intervals = vi.spyOn(globalThis, "setInterval"),
        clearLifetime = vi.spyOn(globalThis, "clearTimeout"),
        clearHeartbeat = vi.spyOn(globalThis, "clearInterval");
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await instance.handle(auth, "/api/events", "GET");
        reader = response.body!.getReader();
        const lifetimeIndex = timeouts.mock.calls.findIndex(
            ([, ms]) => ms === 55000,
          ),
          heartbeatIndex = intervals.mock.calls.findIndex(
            ([, ms]) => ms === 2000,
          );
        expect(lifetimeIndex).toBeGreaterThanOrEqual(0);
        expect(heartbeatIndex).toBeGreaterThanOrEqual(0);
        if (reason !== "backpressure") await reader.read();
        if (reason === "cancel") await reader.cancel();
        else if (reason === "expiry")
          (timeouts.mock.calls[lifetimeIndex][0] as () => void)();
        else {
          if (reason === "revocation") {
            const store = new StateStore(ctx.storage),
              state = store.load()!;
            delete state.sessions[auth.id];
            store.save(state);
          }
          (intervals.mock.calls[heartbeatIndex][0] as () => void)();
        }
        expect(clearLifetime).toHaveBeenCalledWith(
          timeouts.mock.results[lifetimeIndex].value,
        );
        expect(clearHeartbeat).toHaveBeenCalledWith(
          intervals.mock.results[heartbeatIndex].value,
        );
      } finally {
        await reader?.cancel();
        timeouts.mockRestore();
        intervals.mockRestore();
        clearLifetime.mockRestore();
        clearHeartbeat.mockRestore();
      }
    });
  },
);
