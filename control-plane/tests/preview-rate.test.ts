import { expect, it, vi } from "vitest";
import { PreviewRelay } from "../src/preview";
import { createState, registerService } from "../src/model";

const pixels = btoa("\0".repeat(3456));
async function setupRateRelay() {
  const relay = new PreviewRelay(),
    state = createState("test-device"),
    expiresAt = Date.now() + 60000,
    session = { kind: "session" as const, id: "browser", expiresAt };
  state.sessions.browser = expiresAt;
  registerService(
    state,
    {
      id: "bridge",
      name: "Bridge",
      template: "custom",
      config: { allowPreview: true },
    },
    "hash",
    "epoch",
    Date.now(),
  );
  relay.update(state);
  const viewer = relay.openViewer(session, state.deviceId),
    reader = viewer.body!.getReader(),
    initial = new TextDecoder().decode((await reader.read()).value);
  const viewerId = JSON.parse(initial.split("\ndata: ")[1]).viewerId as string;
  const response = relay.openPublisher(
      { kind: "publisher", serviceId: "bridge", hash: "hash" },
      "mac",
      "epoch",
    ),
    socket = response.webSocket!,
    errors: string[] = [];
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    if (value.type === "error") errors.push(value.code);
  });
  socket.accept();
  const frames: number[] = [];
  const drained = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        const event = new TextDecoder().decode(value);
        if (event.startsWith("event: frame\n"))
          frames.push(JSON.parse(event.split("\ndata: ")[1]).sequence);
      }
    } catch {}
  })();
  const send = (sequence: number) =>
    socket.send(
      JSON.stringify({
        type: "frame",
        sequence,
        capturedAt: Date.now(),
        pixels,
      }),
    );
  const close = async () => {
    socket.close();
    try {
      relay.viewer(session, viewerId, "close");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "PREVIEW_VIEWER_NOT_FOUND"
      )
        throw error;
    }
    await reader.cancel().catch(() => {});
    await drained;
  };
  return {
    relay,
    state,
    session,
    viewerId,
    reader,
    socket,
    errors,
    frames,
    send,
    close,
  };
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("accepts a one-second coalesced frame burst and forwards its newest frame with bounded work", async () => {
  const s = await setupRateRelay();
  try {
    for (let sequence = 1; sequence <= 30; sequence++) s.send(sequence);
    await wait(150);
    expect(s.errors).toEqual([]);
    expect(s.relay.status()).toMatchObject({
      connected: true,
      lastSequence: 30,
    });
    expect(s.frames.at(-1)).toBe(30);
    expect(s.relay.status().acceptedFps).toBeLessThanOrEqual(7);
  } finally {
    await s.close();
  }
});

it("keeps a paced thirty-fps publisher connected beyond five seconds", async () => {
  const s = await setupRateRelay();
  try {
    for (let sequence = 1; sequence <= 165; sequence++) {
      s.send(sequence);
      await wait(34);
      if (sequence % 60 === 0) s.relay.viewer(s.session, s.viewerId, "renew");
    }
    expect(s.errors).toEqual([]);
    expect(s.relay.status()).toMatchObject({
      connected: true,
      lastSequence: 165,
    });
  } finally {
    await s.close();
  }
}, 10000);

it("uses trusted timer I/O time when all165 WebSocket callbacks observe a frozen clock", async () => {
  const nativeNow = Date.now.bind(Date),
    nativeTimeout = globalThis.setTimeout,
    frozenAt = nativeNow();
  let inTimer = false;
  const clock = vi
    .spyOn(Date, "now")
    .mockImplementation(() => (inTimer ? nativeNow() : frozenAt));
  vi.stubGlobal("setTimeout", (callback: () => void, ms?: number) =>
    nativeTimeout(() => {
      inTimer = true;
      try {
        callback();
      } finally {
        inTimer = false;
      }
    }, ms),
  );
  let s: Awaited<ReturnType<typeof setupRateRelay>> | undefined;
  try {
    s = await setupRateRelay();
    for (let sequence = 1; sequence <= 165; sequence++) {
      s.send(sequence);
      await wait(34);
      if (sequence % 60 === 0) s.relay.viewer(s.session, s.viewerId, "renew");
    }
    await wait(100);
    expect(s.errors).toEqual([]);
    expect(s.relay.status()).toMatchObject({
      connected: true,
      lastSequence: 165,
    });
  } finally {
    await s?.close();
    clock.mockRestore();
    vi.unstubAllGlobals();
  }
}, 10000);

it("records valid heartbeat liveness at the timer boundary without trusting sender time", async () => {
  const start = Date.now(),
    nativeTimeout = globalThis.setTimeout;
  let timerNow = start,
    inTimer = false;
  const clock = vi
    .spyOn(Date, "now")
    .mockImplementation(() => (inTimer ? timerNow : start));
  vi.stubGlobal("setTimeout", (callback: () => void, ms?: number) =>
    nativeTimeout(() => {
      inTimer = true;
      try {
        callback();
      } finally {
        inTimer = false;
      }
    }, ms),
  );
  let s: Awaited<ReturnType<typeof setupRateRelay>> | undefined;
  try {
    s = await setupRateRelay();
    timerNow += 10000;
    s.socket.send(JSON.stringify({ type: "heartbeat" }));
    await wait(10);
    timerNow += 10000;
    // An independent server I/O event occurs ten seconds after the heartbeat.
    const connected = await new Promise<boolean>((resolve) =>
      setTimeout(() => {
        resolve(s!.relay.status().connected);
      }, 1),
    );
    expect(connected).toBe(true);
  } finally {
    await s?.close();
    clock.mockRestore();
    vi.unstubAllGlobals();
  }
});

it.each(["valid", "invalid", "revoked"] as const)(
  "handles an accepted %s heartbeat when idle expiry runs before clock synchronization",
  async (mode) => {
    const nativeTimeout = globalThis.setTimeout,
      start = Date.now(),
      timers = new Map<number, { callback: () => void; delay: number }>();
    let now = start,
      nextTimer = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("setTimeout", (callback: () => void, delay: number) => {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    });
    vi.stubGlobal("clearTimeout", (id: number) => timers.delete(id));
    const fire = (id: number) => {
      const timer = timers.get(id)!;
      timers.delete(id);
      timer.callback();
    };
    let s: Awaited<ReturnType<typeof setupRateRelay>> | undefined;
    try {
      s = await setupRateRelay();
      const idleId = [...timers].find(([, timer]) => timer.delay === 15000)![0];
      // A just-arrived WS heartbeat observes the old opening-event clock.
      s.socket.send(
        JSON.stringify(
          mode === "invalid"
            ? { type: "heartbeat", extra: true }
            : { type: "heartbeat" },
        ),
      );
      await new Promise((resolve) => nativeTimeout(resolve, 0));
      if (mode === "revoked") {
        s.state.services.bridge.config.allowPreview = false;
        s.relay.update(s.state);
      }
      const syncId = [...timers].find(([, timer]) => timer.delay === 1)?.[0];
      now = start + 15000;
      if (timers.has(idleId)) fire(idleId);
      expect(s.relay.status().connected).toBe(mode === "valid");
      if (mode === "valid") {
        expect(syncId).toBeDefined();
        // A later clock callback must not count the same heartbeat twice.
        now++;
        fire(syncId!);
        const nextIdleId = [...timers].find(
          ([, timer]) => timer.delay === 15000,
        )![0];
        now = start + 30000;
        fire(nextIdleId);
        expect(s.relay.status().connected).toBe(false);
      }
    } finally {
      await s?.close();
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);

it("disconnects abusive immediate ingress instead of accumulating a frame queue", async () => {
  const s = await setupRateRelay();
  try {
    for (let sequence = 1; sequence <= 100; sequence++) s.send(sequence);
    await wait(100);
    expect(s.errors).toContain("PREVIEW_RATE_LIMIT");
    expect(s.relay.status()).toMatchObject({
      connected: false,
      lastSequence: null,
    });
  } finally {
    await s.close();
  }
});

it("cancels the pending newest frame when publisher authority is revoked", async () => {
  const s = await setupRateRelay();
  try {
    for (let sequence = 1; sequence <= 30; sequence++) s.send(sequence);
    await wait(10);
    s.state.services.bridge.config.allowPreview = false;
    s.relay.update(s.state);
    await wait(100);
    expect(s.relay.status()).toMatchObject({
      connected: false,
      lastSequence: null,
    });
  } finally {
    await s.close();
  }
});

it("retains a renewed viewer beyond 55 seconds, bounded by the real session", async () => {
  const nativeNow = Date.now.bind(Date),
    base = nativeNow();
  let offset = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => base + offset);
  const relay = new PreviewRelay(),
    state = createState("device");
  const auth = {
    kind: "session" as const,
    id: "browser",
    expiresAt: base + 120000,
  };
  state.sessions.browser = auth.expiresAt;
  relay.update(state);
  const response = relay.openViewer(auth, state.deviceId),
    reader = response.body!.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  const id = JSON.parse(initial.split("\ndata: ")[1]).viewerId;
  try {
    for (offset = 5000; offset <= 60000; offset += 5000)
      relay.viewer(auth, id, "renew");
    expect(relay.status().viewers).toBe(1);
    offset = 120001;
    expect(relay.status().viewers).toBe(0);
  } finally {
    clock.mockRestore();
    await reader.cancel().catch(() => {});
  }
});

it("sends SSE keepalives while the bridge has no frame to send", async () => {
  const relay = new PreviewRelay(),
    state = createState("device");
  const auth = {
    kind: "session" as const,
    id: "browser",
    expiresAt: Date.now() + 120000,
  };
  state.sessions.browser = auth.expiresAt;
  relay.update(state);
  const response = relay.openViewer(auth, state.deviceId),
    reader = response.body!.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  const id = JSON.parse(initial.split("\ndata: ")[1]).viewerId;
  try {
    const result = await Promise.race([
      reader.read().then((v) => new TextDecoder().decode(v.value)),
      wait(2300).then(() => "missing keepalive"),
    ]);
    expect(result).toContain(": preview keepalive");
  } finally {
    relay.viewer(auth, id, "close");
    await reader.cancel().catch(() => {});
  }
});
