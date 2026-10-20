import { enrollTestBrowser } from "./helpers/computer";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { digest, signSession } from "../src/security";
import { StateStore } from "../src/store";
const origin = "https://control.test";
const pixels = btoa("\0".repeat(3456));
async function setup(
  config: Record<string, unknown> = { allowPreview: true },
  lifetime = 60000,
) {
  const deviceId = await digest(crypto.randomUUID()),
    id = crypto.randomUUID(),
    expiresAt = Date.now() + lifetime;
  await env.DEVICES.getByName(deviceId).login(deviceId, "", id, expiresAt);
  const cookie =
    "busy_session=" +
    encodeURIComponent(
      await signSession({ deviceId, id, expiresAt }, env.SESSION_SIGNING_KEY),
    );
  await enrollTestBrowser(deviceId, cookie);
  const admin = (
    path: string,
    body?: unknown,
    method = body ? "POST" : "GET",
    signal?: AbortSignal,
  ) =>
    SELF.fetch(origin + path, {
      method,
      signal,
      headers: {
        cookie,
        Origin: origin,
        "X-Busy-Device": deviceId,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const reg = await admin("/api/services", {
    id: "bridge",
    name: "Bridge",
    template: "custom",
    config,
    expectedRevision: 0,
  });
  expect(reg.status).toBe(201);
  const { credential, epoch } = (await reg.json()) as {
    credential: string;
    epoch: string;
  };
  const connect = (extra: Record<string, string> = {}) =>
    SELF.fetch(origin + "/api/preview/publish", {
      headers: {
        Authorization: "Bearer " + credential,
        Upgrade: "websocket",
        "X-Busy-Instance": "mac",
        "X-Busy-Epoch": epoch,
        ...extra,
      },
    });
  return { deviceId, admin, connect, credential, epoch, cookie, id };
}
function messages(socket: WebSocket) {
  const values: any[] = [];
  socket.addEventListener("message", (event) => {
    values.push(JSON.parse(String(event.data)));
  });
  socket.accept();
  return values;
}
async function waitMessage(
  values: any[],
  type: string,
  predicate = (v: any) => true,
) {
  await vi.waitFor(() =>
    expect(values.some((v) => v.type === type && predicate(v))).toBe(true),
  );
  return values.find((v) => v.type === type && predicate(v));
}
const buffers = new WeakMap<object, string>();
async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  name: string,
) {
  let buffer = buffers.get(reader) ?? "";
  for (let i = 0; i < 30; i++) {
    const boundary = buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      buffers.set(reader, buffer);
      if (event.startsWith("event: " + name + "\n"))
        return JSON.parse(event.split("\ndata: ")[1]);
      continue;
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("closed before " + name);
    buffer += new TextDecoder().decode(value);
  }
  throw new Error("event missing");
}
async function openPreview(s: Awaited<ReturnType<typeof setup>>) {
  const abort = new AbortController();
  const response = await s.admin(
    "/api/preview/frames/" + s.deviceId,
    undefined,
    "GET",
    abort.signal,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const initial = await readEvent(reader, "preview");
  return {
    reader,
    initial,
    cancel: async () => {
      await s.admin("/api/preview/viewer", {
        viewerId: initial.viewerId,
        operation: "close",
      });
      abort.abort();
      await reader.cancel();
    },
  };
}
describe("read-only pixel preview Worker/DO relay", () => {
  it("requires admin pixel reads and binds SSE URL to verified device", async () => {
    const s = await setup(),
      other = await setup();
    expect((await s.admin("/api/preview/status")).status).toBe(200);
    expect(
      (await s.admin("/api/preview/frames/" + other.deviceId)).status,
    ).toBe(409);
    for (const path of [
      "/api/preview/status",
      "/api/preview/frames/" + s.deviceId,
    ])
      expect(
        (
          await SELF.fetch(origin + path, {
            headers: { Authorization: "Bearer " + s.credential },
          })
        ).status,
      ).toBe(403);
    expect(
      (
        await env.DEVICES.getByName(s.deviceId).fetch(
          "https://untrusted.test/api/preview/status",
        )
      ).status,
    ).toBe(403);
    const { reader, initial } = await openPreview(s);
    expect(initial.deviceId).toBe(s.deviceId);
    await reader.cancel();
  });
  it("requires enabled explicit capability, current epoch and valid instance", async () => {
    const disabled = await setup({});
    expect((await disabled.connect()).status).toBe(403);
    const s = await setup();
    expect((await s.connect({ "X-Busy-Instance": "bad/name" })).status).toBe(
      400,
    );
    expect((await s.connect({ "X-Busy-Epoch": "old" })).status).toBe(409);
    expect((await s.admin("/api/preview/publish")).status).toBe(403);
    await s.admin(
      "/api/services/bridge",
      { expectedRevision: 1, config: { enabled: false } },
      "PATCH",
    );
    expect((await s.connect()).status).toBe(403);
  });
  it("holds a single publisher lease, signals demand, relays RGB and never stores pixels", async () => {
    const s = await setup();
    const response = await s.connect();
    expect(response.status).toBe(101);
    const socket = response.webSocket!,
      events = messages(socket);
    const demand = await waitMessage(events, "demand");
    expect(demand).toMatchObject({
      enabled: false,
      targetFps: 30,
      deviceId: s.deviceId,
    });
    expect((await s.connect({ "X-Busy-Instance": "other" })).status).toBe(409);
    const { reader, cancel } = await openPreview(s);
    await waitMessage(events, "demand", (v) => v.enabled);
    socket.send(
      JSON.stringify({
        type: "frame",
        sequence: 1,
        capturedAt: Date.now(),
        pixels,
      }),
    );
    const frame = await readEvent(reader, "frame");
    expect(frame).toMatchObject({
      deviceId: s.deviceId,
      streamId: demand.streamId,
      sequence: 1,
      width: 72,
      height: 16,
      pixels,
    });
    expect(frame.receivedAt).toBeGreaterThan(0);
    expect(frame.serverNow).toBeGreaterThanOrEqual(frame.receivedAt);
    expect(frame.serverNow - frame.receivedAt).toBeLessThanOrEqual(2000);
    const status = (await (await s.admin("/api/preview/status")).json()) as any;
    expect(status).toMatchObject({
      connected: true,
      serviceId: "bridge",
      instanceId: "mac",
      demand: true,
      viewers: 1,
    });
    expect(status.acceptedFps).toBeGreaterThan(0);
    await runInDurableObject(
      env.DEVICES.getByName(s.deviceId),
      (_instance, ctx) => {
        const state = new StateStore(ctx.storage).load()!;
        expect(JSON.stringify(state)).not.toContain(pixels);
        expect(
          ctx.storage.sql
            .exec("SELECT * FROM audit")
            .toArray()
            .some((v) => JSON.stringify(v).includes(pixels)),
        ).toBe(false);
      },
    );
    await cancel();
    await waitMessage(
      events,
      "demand",
      (v) => !v.enabled && events.indexOf(v) > 0,
    );
    socket.close();
  });
  it("revocation immediately clears cached frame and disconnects active publisher", async () => {
    const s = await setup(),
      { reader } = await openPreview(s),
      response = await s.connect();
    expect(response.status).toBe(101);
    const socket = response.webSocket!,
      events = messages(socket);
    await waitMessage(events, "demand", (v) => v.enabled);
    socket.send(
      JSON.stringify({
        type: "frame",
        sequence: 1,
        capturedAt: Date.now(),
        pixels,
      }),
    );
    await readEvent(reader, "frame");
    await s.admin("/api/services/bridge/revoke", { expectedRevision: 1 });
    const status = await readEvent(reader, "preview");
    expect(status).toMatchObject({ connected: false, lastFrameAt: null });
    expect((await s.connect()).status).toBe(401);
    await reader.cancel();
    socket.close();
  });
  it.each([
    [
      "malformed",
      { type: "frame", sequence: 1, capturedAt: 0, pixels: "bad" },
      "INVALID_PREVIEW_FRAME",
    ],
    [
      "stale",
      { type: "frame", sequence: 1, capturedAt: 1, pixels },
      "PREVIEW_STALE_FRAME",
    ],
    [
      "future",
      { type: "frame", sequence: 1, capturedAt: Date.now() + 600000, pixels },
      "PREVIEW_STALE_FRAME",
    ],
    ["binary", new Uint8Array([1, 2]), "INVALID_PREVIEW_FRAME"],
    ["oversized", "x".repeat(6145), "PREVIEW_FRAME_SIZE"],
  ])("rejects %s frames with safe error", async (_label, value, code) => {
    const s = await setup(),
      { reader } = await openPreview(s),
      response = await s.connect();
    expect(response.status).toBe(101);
    const socket = response.webSocket!,
      events = messages(socket);
    await waitMessage(events, "demand", (v) => v.enabled);
    socket.send(
      typeof value === "string" || value instanceof Uint8Array
        ? value
        : JSON.stringify(value),
    );
    expect(await waitMessage(events, "error")).toEqual({ type: "error", code });
    await reader.cancel();
    socket.close();
  });
  it("rejects replay, no demand and floods while allowing arrival jitter", async () => {
    for (const test of ["replay", "no-demand", "flood"]) {
      const s = await setup(),
        view = test === "no-demand" ? null : await openPreview(s),
        response = await s.connect();
      expect(response.status).toBe(101);
      const socket = response.webSocket!,
        events = messages(socket);
      await waitMessage(events, "demand");
      const send = (sequence: number) =>
        socket.send(
          JSON.stringify({
            type: "frame",
            sequence,
            capturedAt: Date.now(),
            pixels,
          }),
        );
      send(1);
      if (test === "replay") send(1);
      if (test === "flood") for (let i = 2; i <= 100; i++) send(i);
      const error = await waitMessage(events, "error");
      expect(error.code).toBe(
        test === "replay"
          ? "PREVIEW_SEQUENCE"
          : test === "no-demand"
            ? "PREVIEW_NO_DEMAND"
            : "PREVIEW_RATE_LIMIT",
      );
      await view?.reader.cancel();
      socket.close();
    }
  });
  it("bounds viewers, drops older queued frames and cleans up on cancellation", async () => {
    const s = await setup(),
      readers = [];
    for (let i = 0; i < 8; i++) readers.push(await openPreview(s));
    expect((await s.admin("/api/preview/frames/" + s.deviceId)).status).toBe(
      429,
    );
    const response = await s.connect();
    expect(response.status).toBe(101);
    const socket = response.webSocket!,
      events = messages(socket);
    await waitMessage(events, "demand");
    for (let i = 1; i <= 5; i++)
      socket.send(
        JSON.stringify({
          type: "frame",
          sequence: i,
          capturedAt: Date.now(),
          pixels,
        }),
      );
    await vi.waitFor(async () =>
      expect(
        ((await (await s.admin("/api/preview/status")).json()) as any)
          .lastSequence,
      ).toBe(5),
    );
    for (const view of readers) await view.cancel();
    await vi.waitFor(async () =>
      expect(
        ((await (await s.admin("/api/preview/status")).json()) as any).viewers,
      ).toBe(0),
    );
    socket.close();
  });
  it("uses a management-only, session-owned renewable demand lease", async () => {
    const s = await setup(),
      view = await openPreview(s);
    expect(view.initial.viewerId).toEqual(expect.any(String));
    const renew = await s.admin("/api/preview/viewer", {
      viewerId: view.initial.viewerId,
      operation: "renew",
    });
    expect(renew.status).toBe(200);
    const sessionId = crypto.randomUUID(),
      expiresAt = Date.now() + 60000;
    await env.DEVICES.getByName(s.deviceId).login(
      s.deviceId,
      "",
      sessionId,
      expiresAt,
    );
    const cookie =
      "busy_session=" +
      encodeURIComponent(
        await signSession(
          { deviceId: s.deviceId, id: sessionId, expiresAt },
          env.SESSION_SIGNING_KEY,
        ),
      );
    const request = (headers: Record<string, string>) =>
      SELF.fetch(origin + "/api/preview/viewer", {
        method: "POST",
        headers: {
          ...headers,
          Origin: origin,
          "X-Busy-Device": s.deviceId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          viewerId: view.initial.viewerId,
          operation: "close",
        }),
      });
    expect((await request({ cookie })).status).toBe(403);
    expect(
      (await request({ Authorization: "Bearer " + s.credential })).status,
    ).toBe(403);
    await view.cancel();
    expect(
      ((await (await s.admin("/api/preview/status")).json()) as any).viewers,
    ).toBe(0);
    expect(
      (
        await s.admin("/api/preview/viewer", {
          viewerId: view.initial.viewerId,
          operation: "renew",
        })
      ).status,
    ).toBe(404);
  });
  it("stops demand when a viewer loses its six-second renewal lease", async () => {
    const s = await setup(),
      view = await openPreview(s),
      response = await s.connect();
    expect(response.status).toBe(101);
    const socket = response.webSocket!,
      events = messages(socket);
    await waitMessage(events, "demand", (v) => v.enabled);
    await new Promise((resolve) => setTimeout(resolve, 6100));
    await waitMessage(events, "demand", (v) => !v.enabled);
    expect(
      ((await (await s.admin("/api/preview/status")).json()) as any).viewers,
    ).toBe(0);
    await view.reader.cancel();
    socket.close();
  }, 10000);
  it("ends preview viewers at session expiry and logout", async () => {
    const s = await setup(),
      { reader } = await openPreview(s);
    await s.admin("/api/session", undefined, "DELETE");
    while (!(await reader.read()).done) {}
    expect((await s.admin("/api/preview/status")).status).toBe(401);
    const short = await setup({ allowPreview: true }, 250),
      view = await openPreview(short);
    while (!(await view.reader.read()).done) {}
  });
});

it("propagates direct DO SSE cancellation into demand cleanup", async () => {
  const s = await setup();
  await runInDurableObject(
    env.DEVICES.getByName(s.deviceId),
    async (instance) => {
      const auth = { kind: "session", id: s.id, expiresAt: Date.now() + 60000 };
      const request = new Request(
        "https://device.internal/api/preview/frames/" + s.deviceId,
        { headers: { "X-Busy-Internal-Auth": JSON.stringify(auth) } },
      );
      const response = await instance.fetch(request),
        reader = response.body!.getReader();
      expect(response.status).toBe(200);
      await reader.read();
      await reader.cancel();
      await Promise.resolve();
      const status = await instance.fetch(
        new Request("https://device.internal/api/preview/status", {
          headers: { "X-Busy-Internal-Auth": JSON.stringify(auth) },
        }),
      );
      expect(((await status.json()) as any).viewers).toBe(0);
    },
  );
});

it("accepts a publisher heartbeat without viewers", async () => {
  const s = await setup(),
    response = await s.connect();
  expect(response.status).toBe(101);
  const socket = response.webSocket!,
    events = messages(socket);
  await waitMessage(events, "demand", (v) => !v.enabled);
  socket.send(JSON.stringify({ type: "heartbeat" }));
  await new Promise((resolve) => setTimeout(resolve, 75));
  expect(events.filter((v) => v.type === "error")).toHaveLength(0);
  expect(
    ((await (await s.admin("/api/preview/status")).json()) as any).connected,
  ).toBe(true);
  socket.close();
});
it("releases a publisher lease after fifteen seconds without frames or heartbeat", async () => {
  const s = await setup(),
    response = await s.connect();
  expect(response.status).toBe(101);
  const socket = response.webSocket!,
    events = messages(socket);
  await waitMessage(events, "demand");
  await new Promise((resolve) => setTimeout(resolve, 15100));
  expect(
    ((await (await s.admin("/api/preview/status")).json()) as any).connected,
  ).toBe(false);
  const replacement = await s.connect();
  expect(replacement.status).toBe(101);
  replacement.webSocket!.accept();
  replacement.webSocket!.close();
  socket.close();
}, 20000);
it("drops harmless extra frames without disconnecting the publisher", async () => {
  const s = await setup(),
    view = await openPreview(s),
    response = await s.connect();
  expect(response.status).toBe(101);
  const socket = response.webSocket!,
    events = messages(socket);
  await waitMessage(events, "demand", (v) => v.enabled);
  for (let i = 1; i <= 9; i++)
    socket.send(
      JSON.stringify({
        type: "frame",
        sequence: i,
        capturedAt: Date.now(),
        pixels,
      }),
    );
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(events.filter((v) => v.type === "error")).toHaveLength(0);
  const status = (await (await s.admin("/api/preview/status")).json()) as any;
  expect(status.connected).toBe(true);
  expect(status.acceptedFps).toBeGreaterThan(0);
  expect(status.acceptedFps).toBeLessThan(9);
  await view.cancel();
  socket.close();
});

it.each(["credential", "capability", "disabled"])(
  "invalidates publisher and frame cache immediately on %s",
  async (operation) => {
    const s = await setup(),
      view = await openPreview(s),
      response = await s.connect();
    expect(response.status).toBe(101);
    const socket = response.webSocket!,
      events = messages(socket);
    await waitMessage(events, "demand", (v) => v.enabled);
    socket.send(
      JSON.stringify({
        type: "frame",
        sequence: 1,
        capturedAt: Date.now(),
        pixels,
      }),
    );
    await readEvent(view.reader, "frame");
    if (operation === "credential")
      await s.admin("/api/services/bridge/credential", { expectedRevision: 1 });
    else
      await s.admin(
        "/api/services/bridge",
        {
          expectedRevision: 1,
          config:
            operation === "capability"
              ? { allowPreview: false }
              : { enabled: false },
        },
        "PATCH",
      );
    const status = await readEvent(view.reader, "preview");
    expect(status).toMatchObject({
      connected: false,
      lastFrameAt: null,
      lastSequence: null,
      streamId: null,
    });
    await view.cancel();
    socket.close();
  },
);

it("coalesces slow-consumer frames in the real DO without loading full state per frame", async () => {
  const s = await setup(),
    hash = await digest(s.credential.split(".")[2]);
  await runInDurableObject(
    env.DEVICES.getByName(s.deviceId),
    async (instance) => {
      const session = {
        kind: "session",
        id: s.id,
        expiresAt: Date.now() + 60000,
      };
      const internal = (
        path: string,
        auth: unknown,
        extra: Record<string, string> = {},
      ) =>
        instance.fetch(
          new Request("https://device.internal" + path, {
            headers: { "X-Busy-Internal-Auth": JSON.stringify(auth), ...extra },
          }),
        );
      const viewer = await internal(
        "/api/preview/frames/" + s.deviceId,
        session,
      );
      const publish = await internal(
        "/api/preview/publish",
        { kind: "publisher", serviceId: "bridge", hash },
        {
          Upgrade: "websocket",
          "X-Busy-Instance": "mac",
          "X-Busy-Epoch": s.epoch,
        },
      );
      expect(publish.status).toBe(101);
      const socket = publish.webSocket!,
        events = messages(socket);
      await waitMessage(events, "demand", (v) => v.enabled);
      const store = (instance as unknown as { store: StateStore }).store;
      const original = store.load;
      let loads = 0;
      store.load = function () {
        loads++;
        return original.call(this);
      };
      try {
        for (let sequence = 1; sequence <= 5; sequence++)
          socket.send(
            JSON.stringify({
              type: "frame",
              sequence,
              capturedAt: Date.now(),
              pixels,
            }),
          );
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(loads).toBe(0);
        const reader = viewer.body!.getReader();
        await readEvent(reader, "preview");
        const frame = await readEvent(reader, "frame");
        expect(frame.sequence).toBe(5);
        await reader.cancel();
      } finally {
        store.load = original;
        socket.close();
      }
    },
  );
});

it("notifies the publisher on every viewer count change", async () => {
  const s = await setup(),
    response = await s.connect();
  expect(response.status).toBe(101);
  const socket = response.webSocket!,
    events = messages(socket);
  await waitMessage(events, "demand");
  const first = await openPreview(s);
  await waitMessage(events, "demand", (v) => v.enabled);
  const count = events.filter((v) => v.type === "demand").length;
  const second = await openPreview(s);
  await vi.waitFor(() =>
    expect(events.filter((v) => v.type === "demand")).toHaveLength(count + 1),
  );
  await first.cancel();
  await second.cancel();
  socket.close();
});

it("closes publisher at epoch expiry even without another request or frame", async () => {
  const s = await setup();
  await runInDurableObject(
    env.DEVICES.getByName(s.deviceId),
    (_instance, ctx) => {
      const store = new StateStore(ctx.storage),
        state = store.load()!;
      state.services.bridge.epochExpiresAt = Date.now() + 250;
      store.save(state);
    },
  );
  const response = await s.connect();
  expect(response.status).toBe(101);
  const socket = response.webSocket!,
    events = messages(socket);
  await waitMessage(events, "demand");
  let closed = false;
  socket.addEventListener("close", () => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(closed).toBe(true);
  socket.close();
});
it("does not replay a cached frame older than two seconds to a new viewer", async () => {
  const s = await setup(),
    first = await openPreview(s),
    response = await s.connect();
  expect(response.status).toBe(101);
  const socket = response.webSocket!,
    events = messages(socket);
  await waitMessage(events, "demand");
  socket.send(
    JSON.stringify({
      type: "frame",
      sequence: 1,
      capturedAt: Date.now(),
      pixels,
    }),
  );
  await readEvent(first.reader, "frame");
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const next = await openPreview(s);
  const pending = readEvent(next.reader, "frame").then(
    () => "frame",
    () => "closed",
  );
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("none"), 100)),
  ]);
  await first.cancel();
  await next.cancel();
  socket.close();
  expect(result).toBe("none");
});
it("aborts an unread pending SSE event at session expiry", async () => {
  const s = await setup();
  await runInDurableObject(
    env.DEVICES.getByName(s.deviceId),
    async (instance) => {
      const response = await instance.fetch(
        new Request(
          "https://device.internal/api/preview/frames/" + s.deviceId,
          {
            headers: {
              "X-Busy-Internal-Auth": JSON.stringify({
                kind: "session",
                id: s.id,
                expiresAt: Date.now() + 150,
              }),
            },
          },
        ),
      );
      // The initial status write remains backpressured while the session expires.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await expect(response.body!.getReader().read()).rejects.toBeDefined();
    },
  );
});

it("drops a completed in-flight frame after demand stops without losing the publisher lease", async () => {
  const s = await setup(),
    response = await s.connect();
  expect(response.status).toBe(101);
  const socket = response.webSocket!,
    events = messages(socket);
  await waitMessage(events, "demand", (v) => !v.enabled);
  socket.send(
    JSON.stringify({
      type: "frame",
      sequence: 1,
      capturedAt: Date.now(),
      pixels,
    }),
  );
  expect((await waitMessage(events, "error")).code).toBe("PREVIEW_NO_DEMAND");
  expect(
    ((await (await s.admin("/api/preview/status")).json()) as any).connected,
  ).toBe(true);
  const view = await openPreview(s);
  await waitMessage(events, "demand", (v) => v.enabled);
  socket.send(
    JSON.stringify({
      type: "frame",
      sequence: 2,
      capturedAt: Date.now(),
      pixels,
    }),
  );
  expect((await readEvent(view.reader, "frame")).sequence).toBe(2);
  await view.cancel();
  socket.close();
});

it.each([
  "revoke",
  "credential",
  "capability",
  "disabled",
  "epoch",
  "disconnect",
])(
  "aborts a backpressured frame before publisher %s can deliver it",
  async (operation) => {
    const s = await setup(),
      hash = await digest(s.credential.split(".")[2]);
    await runInDurableObject(
      env.DEVICES.getByName(s.deviceId),
      async (instance, ctx) => {
        if (operation === "epoch") {
          const store = new StateStore(ctx.storage),
            state = store.load()!;
          state.services.bridge.epochExpiresAt = Date.now() + 300;
          store.save(state);
        }
        const auth = {
          kind: "session" as const,
          id: s.id,
          expiresAt: Date.now() + 60000,
        };
        const internal = (
          path: string,
          role: unknown,
          extra: Record<string, string> = {},
        ) =>
          instance.fetch(
            new Request("https://device.internal" + path, {
              headers: {
                "X-Busy-Internal-Auth": JSON.stringify(role),
                ...extra,
              },
            }),
          );
        const response = await internal(
          "/api/preview/publish",
          { kind: "publisher", serviceId: "bridge", hash },
          {
            Upgrade: "websocket",
            "X-Busy-Instance": "mac",
            "X-Busy-Epoch": s.epoch,
          },
        );
        expect(response.status).toBe(101);
        const socket = response.webSocket!,
          events = messages(socket);
        await waitMessage(events, "demand");
        const viewer = await internal(
            "/api/preview/frames/" + s.deviceId,
            auth,
          ),
          reader = viewer.body!.getReader();
        await readEvent(reader, "preview");
        await waitMessage(events, "demand", (v) => v.enabled);
        socket.send(
          JSON.stringify({
            type: "frame",
            sequence: 1,
            capturedAt: Date.now(),
            pixels,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        const accepted = await internal("/api/preview/status", auth);
        expect(((await accepted.json()) as any).lastSequence).toBe(1);
        if (operation === "epoch")
          await new Promise((resolve) => setTimeout(resolve, 350));
        else if (operation === "disconnect") {
          socket.close();
          await new Promise((resolve) => setTimeout(resolve, 50));
        } else {
          const path =
            operation === "revoke" || operation === "credential"
              ? "/api/services/bridge/" + operation
              : "/api/services/bridge";
          const body =
            operation === "capability"
              ? { expectedRevision: 1, config: { allowPreview: false } }
              : operation === "disabled"
                ? { expectedRevision: 1, config: { enabled: false } }
                : { expectedRevision: 1 };
          const result = await instance.handle(
            auth,
            path,
            operation === "capability" || operation === "disabled"
              ? "PATCH"
              : "POST",
            body,
          );
          expect(result.status).toBe(200);
        }
        const next = await reader.read().then(
          (result) => (result.done ? "closed" : "event"),
          (error) => String(error.message),
        );
        expect(next).toBe("PREVIEW_VIEWER_CLOSED");
        const status = await internal("/api/preview/status", auth);
        expect(await status.json()).toMatchObject({
          connected: false,
          lastFrameAt: null,
          lastSequence: null,
          viewers: 0,
        });
        socket.close();
      },
    );
  },
);

it("distinguishes an unreleased same-instance publisher lease from an expired epoch", async () => {
  const s = await setup();
  const first = await s.connect();
  expect(first.status).toBe(101);
  const socket = first.webSocket!;
  const events = messages(socket);
  await waitMessage(events, "demand");
  try {
    const overlap = await s.connect();
    expect(overlap.status).toBe(409);
    expect(await overlap.json()).toEqual({ error: "PREVIEW_PUBLISHER_EXISTS" });
    const staleEpoch = await s.connect({ "X-Busy-Epoch": "old" });
    expect(staleEpoch.status).toBe(409);
    expect(await staleEpoch.json()).toEqual({ error: "EPOCH_EXPIRED" });
    expect(
      ((await (await s.admin("/api/preview/status")).json()) as any).connected,
    ).toBe(true);
  } finally {
    socket.close();
  }
  await vi.waitFor(async () => {
    expect(
      ((await (await s.admin("/api/preview/status")).json()) as any).connected,
    ).toBe(false);
  });
  const replacement = await s.connect();
  expect(replacement.status).toBe(101);
  replacement.webSocket!.accept();
  replacement.webSocket!.close();
});
