import type { Element, State } from "./model";

export const FADE_MS = 200;
export const BLACK_MS = 200;
export const MOTION_SAMPLE_MS = 50;
const PREFIX = "control-service-motion-";

/** A single exit survives candidate changes; only native acknowledgements advance it. */
export interface ServiceMotion {
  id: number;
  phase: "fade" | "black" | "handoff";
  elapsedMs: number;
  /** Monotonic sample gate; wall-clock dueAt only wakes the Durable Object. */
  nextSampleMs?: number;
}

/**
 * Monotonic while this object is alive. Persisted elapsed time is a lower bound
 * after eviction: resume the remainder, never replay the completed fade. Wall
 * time schedules alarms but does not determine opacity or complete a black hold.
 */
export class ServiceMotionClock {
  private anchor?: { id: number; phase: string; at: number; elapsed: number };
  constructor(private readonly clock: () => number = () => performance.now()) {}
  elapsed(motion: ServiceMotion): number {
    const now = this.clock();
    if (
      !this.anchor ||
      this.anchor.id !== motion.id ||
      this.anchor.phase !== motion.phase
    )
      this.anchor = {
        id: motion.id,
        phase: motion.phase,
        at: now,
        elapsed: motion.elapsedMs,
      };
    const elapsed = this.anchor.elapsed + Math.max(0, now - this.anchor.at);
    motion.elapsedMs = Math.max(motion.elapsedMs, elapsed);
    return motion.elapsedMs;
  }
  reset() {
    this.anchor = undefined;
  }
}

export function motionOpacity(elapsedMs: number): number {
  // Floor preserves a distinct not-yet-black sample at 199ms.
  return Math.floor(100 * Math.max(0, Math.min(1, elapsedMs / FADE_MS)));
}

export function isMotionElement(id: string): boolean {
  return id.startsWith(PREFIX);
}

/** Acknowledged transparent masks mean an incoming view is already visible. */
export function visibleHandoff(
  state: Pick<State, "serviceMotion" | "nativeElements">,
): boolean {
  if (state.serviceMotion?.phase !== "handoff") return false;
  const masks = Object.values(state.nativeElements).filter((e) =>
    isMotionElement(e.id),
  );
  return masks.length > 0 && masks.every((e) => e.opacity === 0);
}

function blackXpm(width: number, height: number): string {
  return `! XPM2\n${width} ${height} 1 1\nB c #000000\n${("B".repeat(width) + "\n").repeat(height)}`;
}

const masks: Element[] = [
  {
    id: PREFIX + "front",
    display: "front",
    x: 0,
    y: 0,
    data: blackXpm(72, 16),
  },
  // Back is 160x80. Strips keep every native element below the 8KiB bound.
  ...Array.from({ length: 4 }, (_, n) => ({
    id: PREFIX + "back-" + n,
    display: "back",
    x: 0,
    y: n * 20,
    data: blackXpm(160, 20),
  })),
].map((e) => ({ ...e, type: "xpmbitmap", z_index: 255 }) as Element);

export function motionElements(opacity: number): Element[] {
  return masks.map((e) => ({ ...e, opacity }));
}
