import { afterEach, describe, expect, it, vi } from "vitest";
import { startEventStream, startPageEventStream } from "../ui/event-stream";

class FakeSource {
  readyState = 0;
  onopen: EventSource["onopen"] = null;
  onerror: EventSource["onerror"] = null;
  close = vi.fn(() => {
    this.readyState = 2;
  });
  private listeners = new Map<
    string,
    ((event: MessageEvent<string>) => void)[]
  >();
  addEventListener = ((
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ) => {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }) as EventSource["addEventListener"];
  error(state = 2) {
    this.readyState = state;
    this.onerror?.call(this as unknown as EventSource, new Event("error"));
  }
  open() {
    this.readyState = 1;
    this.onopen?.call(this as unknown as EventSource, new Event("open"));
  }
  snapshot(data = "{}") {
    this.emit("snapshot", data);
  }
  emit(type: string, data: string) {
    for (const listener of this.listeners.get(type) ?? [])
      listener(new MessageEvent(type, { data }));
  }
}

function setup() {
  vi.useFakeTimers();
  const sources: FakeSource[] = [];
  let current = true;
  const onError = vi.fn();
  const onOpen = vi.fn();
  const onSnapshot = vi.fn(() => true);
  const stream = startEventStream({
    createSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    isCurrent: () => current,
    onOpen,
    onSnapshot,
    onError,
  });
  return {
    sources,
    stream,
    onError,
    onOpen,
    onSnapshot,
    expire: () => {
      current = false;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("snapshot EventSource recovery", () => {
  it("replaces a permanently CLOSED stream after a delay", () => {
    const { sources, stream, onError } = setup();
    sources[0].error();
    expect(onError).toHaveBeenCalledOnce();
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
    expect(sources[0].close).toHaveBeenCalledOnce();
    stream.close();
  });

  it("closes CONNECTING native retry and owns exactly one recovery timer", () => {
    const { sources, stream } = setup();
    sources[0].error(0);
    expect(sources[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    sources[0].error(0);
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
    stream.close();
  });

  it("deduplicates CLOSED errors and caps exponential retry delays at 30 seconds", () => {
    const { sources, stream } = setup();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = sources.length;
      sources.at(-1)!.error();
      sources.at(-1)!.error();
      vi.advanceTimersByTime(delay - 1);
      expect(sources).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(sources).toHaveLength(count + 1);
    }
    stream.close();
  });

  it.each(["snapshot", "error"] as const)(
    "resets backoff after useful stable progress at %s",
    (event) => {
      const { sources, stream } = setup();
      sources[0].error();
      vi.advanceTimersByTime(1000);
      sources[1].open();
      sources[1].snapshot();
      vi.advanceTimersByTime(5000);
      if (event === "snapshot") sources[1].snapshot();
      sources[1].error();
      vi.advanceTimersByTime(1000);
      expect(sources).toHaveLength(3);
      stream.close();
    },
  );

  it("does not reset retry backoff for repeated short-lived successful handshakes", () => {
    const { sources, stream } = setup();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000]) {
      const count = sources.length;
      sources.at(-1)!.open();
      sources.at(-1)!.snapshot();
      sources.at(-1)!.error(0);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(delay - 1);
      expect(sources).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(sources).toHaveLength(count + 1);
    }
    stream.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reset backoff for rejected snapshots", () => {
    const { sources, stream, onSnapshot } = setup();
    sources[0].error();
    vi.advanceTimersByTime(1000);
    onSnapshot.mockReturnValue(false);
    sources[1].snapshot();
    vi.advanceTimersByTime(5000);
    sources[1].error();
    vi.advanceTimersByTime(1999);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(3);
    stream.close();
  });

  it("ignores late events from a replaced connection", () => {
    const { sources, stream, onError, onOpen, onSnapshot } = setup();
    sources[0].error();
    vi.advanceTimersByTime(1000);
    sources[0].open();
    sources[0].snapshot();
    sources[0].error();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60000);
    expect(sources).toHaveLength(2);
    stream.close();
  });

  it("cancels recovery and closes the active stream on logout or unmount", () => {
    const { sources, stream, onError, onOpen, onSnapshot } = setup();
    sources[0].error();
    stream.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(sources[0].close).toHaveBeenCalledOnce();
    sources[0].open();
    sources[0].snapshot();
    sources[0].error();
    vi.advanceTimersByTime(60000);
    expect(sources).toHaveLength(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("fences queued recovery and late events when the session generation changes", () => {
    const { sources, stream, expire, onError, onOpen, onSnapshot } = setup();
    sources[0].error();
    expire();
    sources[0].open();
    sources[0].snapshot();
    sources[0].error();
    vi.advanceTimersByTime(60000);
    expect(sources).toHaveLength(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    stream.close();
  });
});

it("recovers CLOSED preview transports and resets backoff after stable authenticated preview", () => {
  vi.useFakeTimers();
  const sources: FakeSource[] = [],
    status = vi.fn(() => true);
  const connection = startEventStream({
    eventName: "preview",
    createSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    isCurrent: () => true,
    onOpen: vi.fn(),
    onError: vi.fn(),
    onSnapshot: status,
  });
  try {
    sources[0].emit("preview", "{}");
    expect(status).toHaveBeenCalledOnce();
    sources[0].error();
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
    sources[1].emit("preview", "{}");
    vi.advanceTimersByTime(5000);
    sources[1].error();
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(3);
  } finally {
    connection.close();
  }
});

it("owns one visible queue stream, cancels hidden recovery, and cleans up page lifecycle listeners", () => {
  vi.useFakeTimers();
  const page = Object.assign(new EventTarget(), { hidden: true }),
    lifecycle = new EventTarget();
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", lifecycle);
  const sources: FakeSource[] = [],
    onSnapshot = vi.fn(() => true);
  const stream = startPageEventStream({
    createSource: () => {
      const s = new FakeSource();
      sources.push(s);
      return s;
    },
    isCurrent: () => true,
    onOpen: vi.fn(),
    onError: vi.fn(),
    onSnapshot,
  });
  try {
    expect(sources).toHaveLength(0);
    page.hidden = false;
    page.dispatchEvent(new Event("visibilitychange"));
    page.dispatchEvent(new Event("visibilitychange"));
    expect(sources).toHaveLength(1);
    sources[0].error(0);
    expect(vi.getTimerCount()).toBe(1);
    page.hidden = true;
    page.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30000);
    expect(sources).toHaveLength(1);
    page.hidden = false;
    page.dispatchEvent(new Event("visibilitychange"));
    expect(sources).toHaveLength(2);
    sources[0].snapshot();
    expect(onSnapshot).not.toHaveBeenCalled();
    sources[1].snapshot();
    expect(onSnapshot).toHaveBeenCalledOnce();
    lifecycle.dispatchEvent(new Event("pagehide"));
    expect(sources[1].close).toHaveBeenCalledOnce();
    lifecycle.dispatchEvent(new Event("pageshow"));
    lifecycle.dispatchEvent(new Event("pageshow"));
    expect(sources).toHaveLength(3);
  } finally {
    stream.close();
  }
  lifecycle.dispatchEvent(new Event("pageshow"));
  page.dispatchEvent(new Event("visibilitychange"));
  expect(sources).toHaveLength(3);
  expect(sources[2].close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
