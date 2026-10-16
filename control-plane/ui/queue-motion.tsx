import { useEffect, useState, useRef, type ReactNode } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { queuePresence, queueExitMs, type QueueRow } from "./queue-layout";

export function useQueuePresence(rows: QueueRow[], enabled: boolean) {
  const signature = JSON.stringify([enabled, rows.map((r) => r.groupId)]);
  const [state, setState] = useState(() => ({
    signature,
    entries: queuePresence<QueueRow>(
      [],
      rows.map((value) => ({ id: value.groupId, value })),
      performance.now(),
      false,
    ),
  }));
  if (state.signature !== signature) {
    setState({
      signature,
      entries: queuePresence(
        state.entries,
        rows.map((value) => ({ id: value.groupId, value })),
        performance.now(),
        enabled,
      ),
    });
  }
  // Refresh live values without replaying transitions on each progress tick.
  const current = new Map(rows.map((r) => [r.groupId, r]));
  const entries = state.entries.map((entry) =>
    current.has(entry.id)
      ? { ...entry, value: current.get(entry.id)!, until: null }
      : entry,
  );
  useEffect(() => {
    const departures = state.entries.flatMap((entry) =>
      entry.until === null ? [] : [entry.until],
    );
    if (!departures.length) return;
    const timer = window.setTimeout(
      () =>
        setState((previous) => ({
          ...previous,
          entries: previous.entries.filter(
            (entry) => entry.until === null || entry.until > performance.now(),
          ),
        })),
      Math.max(0, Math.min(...departures) - performance.now()) + 16,
    );
    return () => window.clearTimeout(timer);
  }, [state]);
  return entries;
}

export function QueueDeparture({ children }: { children: ReactNode }) {
  const scope = useRef<HTMLLIElement>(null);
  useGSAP(
    () => {
      gsap.to(scope.current, {
        opacity: 0,
        height: 0,
        marginBottom: 0,
        duration: queueExitMs / 1000,
        ease: "power3.inOut",
        overflow: "hidden",
      });
    },
    { scope },
  );
  return (
    <li ref={scope} className="queue-departure" inert aria-hidden="true">
      {children}
    </li>
  );
}
