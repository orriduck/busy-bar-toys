type EventStreamSource = Pick<
  EventSource,
  "readyState" | "onopen" | "onerror" | "addEventListener" | "close"
>;

type EventStreamOptions = {
  eventName?: string;
  createSource: () => EventStreamSource;
  isCurrent: () => boolean;
  onOpen: () => void;
  onSnapshot: (data: string) => boolean;
  onError: () => void;
};

/** Own one authenticated named-event stream and one bounded recovery timer. */
export function startEventStream(options: EventStreamOptions) {
  let source: EventStreamSource | null = null;
  let recovery: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  let stopped = false;
  const current = () => !stopped && options.isCurrent();
  const reset = () => {
    clearTimeout(recovery);
    recovery = undefined;
    delay = 1000;
  };
  const connect = () => {
    if (!current()) return;
    source?.close();
    const events = options.createSource();
    source = events;
    const startedAt = Date.now();
    let useful = false;
    const active = () => current() && source === events;
    events.onopen = () => {
      if (!active()) return;
      options.onOpen();
    };
    events.addEventListener(options.eventName ?? "snapshot", (event) => {
      if (!active()) return;
      if (options.onSnapshot((event as MessageEvent<string>).data)) {
        useful = true;
        if (Date.now() - startedAt >= 5000) reset();
      }
    });
    events.onerror = () => {
      if (!active()) return;
      if (useful && Date.now() - startedAt >= 5000) reset();
      options.onError();
      if (!active()) return;
      // Own CONNECTING and CLOSED recovery alike: native retries otherwise
      // bypass our backoff and race explicit recovery after capacity rejection.
      events.close();
      source = null;
      if (recovery !== undefined) return;
      recovery = setTimeout(() => {
        recovery = undefined;
        if (current() && source === null) connect();
      }, delay);
      delay = Math.min(delay * 2, 30000);
    };
  };
  connect();
  return {
    close() {
      stopped = true;
      reset();
      source?.close();
      source = null;
    },
  };
}

/** Queue pages release their stream while hidden, including pending recovery. */
export function startPageEventStream(
  options: EventStreamOptions & { onPause?: () => void; onResume?: () => void },
) {
  let connection: ReturnType<typeof startEventStream> | null = null;
  let disposed = false,
    pageActive = true;
  const current = () =>
    !disposed && pageActive && !document.hidden && options.isCurrent();
  const sync = () => {
    if (current()) {
      if (!connection) {
        options.onResume?.();
        connection = startEventStream({ ...options, isCurrent: current });
      }
    } else if (connection) {
      connection.close();
      connection = null;
      options.onPause?.();
    }
  };
  const leave = () => {
    pageActive = false;
    sync();
  };
  const restore = () => {
    pageActive = true;
    sync();
  };
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("pagehide", leave);
  window.addEventListener("pageshow", restore);
  sync();
  return {
    close() {
      disposed = true;
      connection?.close();
      connection = null;
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", restore);
    },
  };
}
