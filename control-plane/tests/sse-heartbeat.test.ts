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

it("coalesces snapshot bursts without closing a temporarily full stream or buffering old revisions", async () => {
  const { stub, auth } = await fixture();
  await runInDurableObject(stub, async (instance, ctx) => {
    const store = new StateStore(ctx.storage),
      response = await instance.handle(auth, "/api/events", "GET"),
      reader = response.body!.getReader();
    const internals = instance as unknown as {
      broadcast: (s: NonNullable<ReturnType<StateStore["load"]>>) => void;
      snapshotStreamHealth: () => {
        active: number;
        pending: number;
        coalesced: number;
        closed: Record<string, number>;
      };
    };
    try {
      const initial = store.load()!,
        state = { ...initial };
      for (let n = 1; n <= 50; n++) {
        state.revision = initial.revision + n;
        store.save(state);
        internals.broadcast(state);
      }
      expect(internals.snapshotStreamHealth()).toMatchObject({
        active: 1,
        pending: 1,
        coalesced: 50,
        closed: { backpressure: 0 },
      });
      const parse = (raw: Uint8Array | undefined) =>
        JSON.parse(new TextDecoder().decode(raw).split("\ndata: ")[1]);
      expect(parse((await reader.read()).value).revision).toBe(
        initial.revision,
      );
      const latest = await reader.read();
      expect(latest.done).toBe(false);
      expect(parse(latest.value).revision).toBe(initial.revision + 50);
      expect(internals.snapshotStreamHealth()).toMatchObject({
        active: 1,
        pending: 0,
      });
    } finally {
      await reader.cancel();
    }
    expect(internals.snapshotStreamHealth()).toMatchObject({
      active: 0,
      closed: { cancelled: 1 },
    });
  });
});

it("does not flush a pending snapshot after authority is revoked", async () => {
  const { stub, auth } = await fixture();
  await runInDurableObject(stub, async (instance, ctx) => {
    const store = new StateStore(ctx.storage),
      response = await instance.handle(auth, "/api/events", "GET"),
      reader = response.body!.getReader();
    const state = store.load()!;
    (instance as unknown as { broadcast: (s: typeof state) => void }).broadcast(
      state,
    );
    delete state.sessions[auth.id];
    store.save(state);
    try {
      await reader.read();
      expect((await reader.read()).done).toBe(true);
    } finally {
      await reader.cancel();
    }
  });
});

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
      const diagnostics = await instance.handle(
        auth,
        "/api/diagnostics/display",
        "GET",
      );
      expect(
        ((await diagnostics.json()) as { snapshotStreams: unknown })
          .snapshotStreams,
      ).toMatchObject({
        active: 16,
        limit: 16,
        activeByKind: { session: 16, computer: 0, publisher: 0 },
        opened: 16,
        capacityRejected: 1,
        serviceConnectionCounts: [],
      });
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
