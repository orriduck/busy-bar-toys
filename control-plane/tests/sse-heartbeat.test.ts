import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { digest } from "../src/security";
import { StateStore } from "../src/store";
import { registerService } from "../src/model";

it.each(["publisher", "computer"] as const)(
  "replaces only an opt-in %s instance at capacity before its old cancellation arrives",
  async (kind) => {
    const { stub, auth } = await fixture();
    await runInDurableObject(stub, async (instance, ctx) => {
      const store = new StateStore(ctx.storage),
        state = store.load()!;
      state.computers.owner = {
        id: "owner",
        credentialHash: "computer-hash",
        createdAt: Date.now(),
        serviceOrder: [],
      };
      registerService(
        state,
        {
          id: "producer",
          name: "Producer",
          template: "custom",
          computerId: "owner",
        },
        "producer-hash",
        "epoch",
        Date.now(),
      );
      store.save(state);
      const publisher =
        kind === "publisher"
          ? { kind, serviceId: "producer", hash: "producer-hash" }
          : {
              kind,
              computerId: "owner",
              serviceId: "producer",
              hash: "computer-hash",
            };
      const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
      try {
        const old = await instance.handle(
          publisher,
          "/api/events",
          "GET",
          {},
          "mac-a",
        );
        const oldReader = old.body!.getReader();
        readers.push(oldReader);
        await oldReader.read();
        const oldStreamId = [...(instance as any).streams.keys()][0];
        for (let n = 0; n < 15; n++) {
          const response = await instance.handle(auth, "/api/events", "GET");
          const reader = response.body!.getReader();
          readers.push(reader);
          await reader.read();
        }
        const replacement = await instance.handle(
          publisher,
          "/api/events",
          "GET",
          {},
          "mac-a",
        );
        expect(replacement.status).toBe(200);
        const reader = replacement.body!.getReader();
        readers.push(reader);
        await reader.read();
        expect((await oldReader.read()).done).toBe(true);
        const stats = (instance as any).snapshotStreamHealth();
        expect(stats).toMatchObject({
          active: 16,
          limit: 16,
          capacityRejected: 0,
          closed: { replaced: 1 },
          serviceConnectionCounts: [1],
        });
        await oldReader.cancel();
        (instance as any).closeStream(oldStreamId, "cancelled");
        expect((instance as any).snapshotStreamHealth().active).toBe(16);
      } finally {
        await Promise.all(readers.map((reader) => reader.cancel()));
      }
    });
  },
);

it("forwards the explicit collector instance through the public Worker route", async () => {
  const { stub } = await fixture();
  const secret = "p".repeat(40),
    hash = await digest(secret);
  const deviceId = await runInDurableObject(stub, (_instance, ctx) => {
    const store = new StateStore(ctx.storage),
      state = store.load()!;
    registerService(
      state,
      { id: "route", name: "Route", template: "custom" },
      hash,
      "epoch",
      Date.now(),
    );
    store.save(state);
    return state.deviceId;
  });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    for (let n = 0; n < 2; n++) {
      const response = await SELF.fetch("https://control.test/api/events", {
        headers: {
          Authorization: `Bearer ${deviceId}.route.${secret}`,
          "X-Busy-Instance": "mac-route",
        },
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      readers.push(reader);
      await reader.read();
    }
    expect((await readers[0].read()).done).toBe(true);
    await runInDurableObject(stub, (instance) => {
      expect((instance as any).snapshotStreamHealth()).toMatchObject({
        active: 1,
        closed: { replaced: 1 },
      });
    });
  } finally {
    await Promise.all(readers.map((reader) => reader.cancel()));
  }
});

it("preserves other producer instances and legacy streams and rejects unauthorized replacement", async () => {
  const { stub } = await fixture();
  await runInDurableObject(stub, async (instance, ctx) => {
    const store = new StateStore(ctx.storage),
      state = store.load()!;
    state.computers.peer = {
      id: "peer",
      credentialHash: "peer-hash",
      createdAt: Date.now(),
      serviceOrder: [],
    };
    registerService(
      state,
      { id: "producer", name: "Producer", template: "custom" },
      "producer-hash",
      "epoch",
      Date.now(),
    );
    store.save(state);
    const auth = {
      kind: "publisher" as const,
      serviceId: "producer",
      hash: "producer-hash",
    };
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      for (const id of ["mac-a", "mac-b", undefined]) {
        const response = await instance.handle(
          auth,
          "/api/events",
          "GET",
          {},
          id,
        );
        const reader = response.body!.getReader();
        readers.push(reader);
        await reader.read();
      }
      expect(
        (
          await instance.handle(
            { ...auth, hash: "wrong" },
            "/api/events",
            "GET",
            {},
            "mac-a",
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await instance.handle(
            {
              kind: "computer",
              computerId: "peer",
              serviceId: "producer",
              hash: "peer-hash",
            },
            "/api/events",
            "GET",
            {},
            "mac-a",
          )
        ).status,
      ).toBe(403);
      expect((instance as any).snapshotStreamHealth().active).toBe(3);
      const replacement = await instance.handle(
        auth,
        "/api/events",
        "GET",
        {},
        "mac-a",
      );
      const reader = replacement.body!.getReader();
      readers.push(reader);
      await reader.read();
      expect((instance as any).snapshotStreamHealth()).toMatchObject({
        active: 3,
        closed: { replaced: 1 },
      });
      expect((await readers[0].read()).done).toBe(true);
    } finally {
      await Promise.all(readers.map((reader) => reader.cancel()));
    }
  });
});

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

it("does not confuse a fresh queued snapshot with a two-second stalled consumer", async () => {
  const { stub, auth } = await fixture();
  await runInDurableObject(stub, async (instance, ctx) => {
    const base = Date.now();
    let now = base;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now),
      intervals = vi.spyOn(globalThis, "setInterval");
    const response = await instance.handle(auth, "/api/events", "GET"),
      reader = response.body!.getReader();
    const inner = instance as unknown as {
      broadcast: (s: NonNullable<ReturnType<StateStore["load"]>>) => void;
      snapshotStreamHealth: () => unknown;
    };
    try {
      await reader.read();
      await Promise.resolve();
      const pulse = intervals.mock.calls.find(
        ([, ms]) => ms === 2000,
      )![0] as () => void;
      now = base + 1999;
      inner.broadcast(new StateStore(ctx.storage).load()!);
      now = base + 2000;
      pulse();
      expect(inner.snapshotStreamHealth()).toMatchObject({
        active: 1,
        oldestBackpressureAgeMs: 1,
        closed: { backpressure: 0 },
      });
      now = base + 3998;
      pulse();
      expect(inner.snapshotStreamHealth()).toMatchObject({
        active: 1,
        closed: { backpressure: 0 },
      });
      now = base + 3999;
      pulse();
      expect(inner.snapshotStreamHealth()).toMatchObject({
        active: 0,
        closed: { backpressure: 1 },
      });
    } finally {
      await reader.cancel();
      clock.mockRestore();
      intervals.mockRestore();
    }
  });
});

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
          const clock =
            reason === "backpressure"
              ? vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2001)
              : null;
          try {
            (intervals.mock.calls[heartbeatIndex][0] as () => void)();
          } finally {
            clock?.mockRestore();
          }
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

it.each(["backpressure", "lifetime"] as const)(
  "reclaims %s streams at reconnect admission when the cleanup timer has not run",
  async (reason) => {
    const { stub, auth } = await fixture();
    await runInDurableObject(stub, async (instance) => {
      const bodies: ReadableStream<Uint8Array>[] = [];
      const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
      const base = Date.now();
      let now = base;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        for (let n = 0; n < 16; n++) {
          const response = await instance.handle(auth, "/api/events", "GET");
          expect(response.status).toBe(200);
          if (reason === "lifetime") {
            const reader = response.body!.getReader();
            readers.push(reader);
            await reader.read();
          } else bodies.push(response.body!);
        }
        now = base + (reason === "lifetime" ? 55001 : 2001);
        const replacement = await instance.handle(auth, "/api/events", "GET");
        if (replacement.body) bodies.push(replacement.body);
        expect(replacement.status).toBe(200);
        const diagnostics = await instance.handle(
          auth,
          "/api/diagnostics/display",
          "GET",
        );
        expect(
          ((await diagnostics.json()) as any).snapshotStreams,
        ).toMatchObject({
          active: 1,
          limit: 16,
          capacityRejected: 0,
          closed: { [reason]: 16 },
        });
      } finally {
        await Promise.all(readers.map((reader) => reader.cancel()));
        await Promise.all(bodies.map((body) => body.cancel()));
        clock.mockRestore();
      }
    });
  },
);
