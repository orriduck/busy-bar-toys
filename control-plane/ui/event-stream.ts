type EventStreamSource = Pick<
  EventSource,
  "readyState" | "onopen" | "onerror" | "addEventListener" | "close"
>;

type EventStreamOptions = {
  createSource: () => EventStreamSource;
  isCurrent: () => boolean;
  onOpen: () => void;
  onSnapshot: (data: string) => boolean;
  onError: () => void;
};

/** Own the authenticated snapshot stream for one mounted session. */
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
    const active = () => current() && source === events;
    events.onopen = () => {
      if (!active()) return;
      reset();
      options.onOpen();
    };
    events.addEventListener("snapshot", (event) => {
      if (!active()) return;
      if (options.onSnapshot((event as MessageEvent<string>).data)) reset();
    });
    events.onerror = () => {
      if (!active()) return;
      options.onError();
      // CONNECTING already has the browser's native retry. HTTP rejection can
      // leave CLOSED permanently, so only that state needs an explicit retry.
      if (!active() || events.readyState !== 2 || recovery !== undefined)
        return;
      recovery = setTimeout(() => {
        recovery = undefined;
        if (active() && events.readyState === 2) connect();
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
