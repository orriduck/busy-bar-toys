import { afterEach, expect, it, vi } from "vitest";
import { Preview } from "../ui/preview";

const hooks = vi.hoisted(() => ({
  surface: null as unknown as HTMLCanvasElement,
  effects: [] as (() => void | (() => void))[],
  messages: [] as unknown[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: () => ({ current: hooks.surface }),
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
  useState: (initial: unknown) => [
    initial,
    (value: unknown) => hooks.messages.push(value),
  ],
}));

afterEach(() => {
  hooks.effects = [];
  hooks.messages = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("clears expired shown pixels without losing a fresh frame waiting after a main-thread stall", () => {
  const epoch = 1_800_000_000_000;
  let now = 0;
  const context = { clearRect: vi.fn() };
  hooks.surface = {
    width: 720,
    height: 160,
    dataset: {},
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { hidden: false }),
  );
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("performance", { now: () => now });
  vi.spyOn(Date, "now").mockImplementation(() => epoch + now);
  vi.stubGlobal("setInterval", () => 1);
  vi.stubGlobal("clearInterval", () => {});
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextRaf = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++nextRaf, callback);
    return nextRaf;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  const events = new EventTarget();
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener = events.addEventListener.bind(events);
      close() {}
    },
  );
  const advance = (time: number) => {
    now = time;
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback(time);
  };
  const sendFrame = (sequence: number) =>
    events.dispatchEvent(
      new MessageEvent("frame", {
        data: JSON.stringify({
          deviceId: "device",
          streamId: "one",
          sequence,
          capturedAt: epoch + now,
          receivedAt: epoch + now,
          width: 72,
          height: 16,
          pixels: btoa("\0".repeat(3456)),
        }),
      }),
    );
  const stats = vi.fn();
  Preview({
    deviceId: "device",
    active: true,
    onSessionEnd: vi.fn(),
    onStats: stats,
  });
  const cleanup = hooks.effects.map((effect) => effect());
  try {
    events.dispatchEvent(
      new MessageEvent("preview", {
        data: JSON.stringify({
          deviceId: "device",
          connected: true,
          demand: true,
          streamId: "one",
        }),
      }),
    );
    sendFrame(1);
    advance(150);
    expect(hooks.surface.dataset.drawnSequence).toBe("1");

    // Network tasks resume before the next RAF after a stalled main thread.
    now = 2100;
    sendFrame(2);
    advance(2100);
    expect(hooks.surface.dataset.receivedFrames).toBe("2");
    expect(hooks.surface.dataset.drawnFrames).toBe("1");
    expect(hooks.messages.at(-1)).toBe("Preview delayed");
    expect(stats.mock.lastCall?.[0].latencyMs).toBeNull();
    const blanks = context.clearRect.mock.calls.length;

    advance(2249);
    expect(hooks.surface.dataset.drawnFrames).toBe("1");
    advance(2250);
    expect(hooks.surface.dataset.drawnSequence).toBe("2");
    expect(hooks.surface.dataset.drawnFrames).toBe("2");
    expect(context.clearRect.mock.calls.length).toBe(blanks + 1);
    expect(hooks.messages.at(-1)).toBe("");
    advance(2300);
    expect(hooks.surface.dataset.drawnFrames).toBe("2");
  } finally {
    for (const stop of cleanup.reverse()) stop?.();
  }
});
