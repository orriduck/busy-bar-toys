import type { Element, State } from "./model";
import { referencedHashes } from "./assets";

export const FADE_MS = 200;
export const BLACK_MS = 200;
const PREFIX = "control-service-motion-";

/** A single exit survives candidate changes; only native acknowledgements advance it. */
export interface ServiceMotion {
  id: number;
  phase: "fade" | "black" | "handoff";
  elapsedMs: number;
  /** Monotonic phase fence; wall-clock dueAt only wakes the Durable Object. */
  nextSampleMs?: number;
  mode?: "native" | "fallback";
  /** Set only after the single native fade-start draw acknowledges. */
  nativeStarted?: boolean;
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

export type MotionFenceWait = (milliseconds: number) => Promise<void>;
export const motionFenceTimer: MotionFenceWait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** A short local wakeup is never phase-completion proof; reload and remeasure. */
export async function waitForMotionFence(
  expected: State,
  clock: ServiceMotionClock,
  reload: () => State | null,
  wait: MotionFenceWait = motionFenceTimer,
): Promise<"ready" | "changed" | "pending"> {
  const motion = expected.serviceMotion,
    command = expected.commands[0];
  if (
    !motion ||
    command?.kind !== "motion" ||
    command.status !== "pending" ||
    command.attempts > 0 ||
    (motion.phase !== "black" &&
      !(motion.phase === "fade" && motion.nativeStarted))
  )
    return "pending";
  const generation = expected.generation,
    id = motion.id,
    phase = motion.phase,
    commandId = command.id,
    target = phase === "black" ? BLACK_MS : FADE_MS;
  const current = () => {
    const state = reload(),
      next = state?.commands[0],
      active = state?.serviceMotion;
    return state?.generation === generation &&
      active?.id === id &&
      active.phase === phase &&
      (phase !== "fade" || active.nativeStarted) &&
      next?.id === commandId &&
      next.kind === "motion" &&
      next.status === "pending" &&
      next.attempts === 0
      ? active
      : null;
  };
  let active = current();
  if (!active) return "changed";
  const remaining = Math.max(
    0,
    // Native timers accept whole milliseconds. Round up a fractional remainder
    // so truncation cannot turn an ordinary wake into another alarm round trip.
    Math.min(target, Math.ceil(target - clock.elapsed(active))),
  );
  if (remaining === 0) return "ready";
  await wait(remaining);
  active = current();
  if (!active) return "changed";
  return clock.elapsed(active) >= target ? "ready" : "pending";
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

/** Firmware 1.2.4 bicycle0: uniform-pixel RLE BGRA, fade0..6 and clear7. */
export function nativeFadeAsset(width: number, height: number): Uint8Array {
  if (
    width < 1 ||
    width > 255 ||
    height < 1 ||
    height > 255 ||
    width * height * 4 > 65535
  )
    throw new Error("Invalid native fade dimensions");
  // Firmware RLE: each low-seven-bit opcode repeats one four-byte BGRA
  // pixel, at most127 times. Avoid per-instance raw-frame scratch allocations.
  const frameBytes = Math.ceil((width * height) / 127) * 5,
    recordBytes = frameBytes + 4;
  const sections = [
    { name: "default", start: 0, end: 7, offset: 0 },
    { name: "fade", start: 0, end: 6, offset: 0 },
    { name: "clear", start: 7, end: 7, offset: 7 * recordBytes },
  ];
  const sectionBytes = sections.reduce((n, s) => n + 14 + s.name.length, 0);
  const result = new Uint8Array(36 + sectionBytes + 8 * recordBytes),
    view = new DataView(result.buffer);
  result.set(new TextEncoder().encode("bicycle0"));
  result[9] = width;
  result[10] = height;
  result[11] = 2;
  result[12] = 30;
  view.setUint16(13, frameBytes, true);
  view.setUint32(16, sectionBytes, true);
  view.setUint32(20, 8 * recordBytes, true);
  view.setUint32(24, sections.length, true);
  view.setUint32(28, 8, true);
  view.setUint32(32, 8, true);
  let offset = 36;
  for (const section of sections) {
    view.setUint32(offset, section.start, true);
    view.setUint32(offset + 4, section.end, true);
    view.setUint32(offset + 8, 36 + sectionBytes + section.offset, true);
    result[offset + 12] = 1;
    result.set(new TextEncoder().encode(section.name), offset + 13);
    offset += 14 + section.name.length;
  }
  for (let frame = 0; frame < 8; frame++) {
    result[offset] = 1; // RLE encoding
    result[offset + 1] = 1;
    view.setUint16(offset + 2, frameBytes, true);
    const t = (frame * 1000) / 30 / FADE_MS;
    // Fresh widget IDs plus alpha1 preserved intermediate levels in a slow
    // hardware probe. The combined changes do not isolate a cache/alpha bug;
    // avoid a fully transparent initial canvas conservatively. Widget
    // opacity0 handles unmasking independently of pixel alpha.
    const alpha =
      frame === 7 ? 0 : Math.max(1, Math.round(255 * t * t * (3 - 2 * t)));
    for (
      let pixel = offset + 4, remaining = width * height;
      remaining > 0;
      pixel += 5
    ) {
      result[pixel] = Math.min(127, remaining);
      result[pixel + 4] = alpha;
      remaining -= result[pixel];
    }
    offset += recordBytes;
  }
  return result;
}

const NATIVE_HASHES = {
  front: "27e262da8497b418e4c763d30d699e9c6e5fc030546e6fac27a7c758271fd266",
  back: "3760f789e7c4639656e0eec53518385c3c9379e8819a86061ed152fd83b12103",
};
let cachedAssets:
  { hash: string; type: string; bytes: number; data: string }[] | undefined;
export function nativeMotionAssets() {
  return (cachedAssets ??= (
    [
      ["front", 72, 16],
      ["back", 160, 80],
    ] as const
  ).map(([name, width, height]) => {
    const raw = nativeFadeAsset(width, height);
    let binary = "";
    for (const byte of raw) binary += String.fromCharCode(byte);
    return {
      hash: NATIVE_HASHES[name],
      type: "anim",
      bytes: raw.length,
      data: btoa(binary),
    };
  }));
}

/** Internal public assets gain no producer ownership and obey existing cache bounds. */
export function cacheNativeMotionAssets(state: State, now: number): boolean {
  return cacheInternalAssets(state, now, nativeMotionAssets());
}

export function cacheInternalAssets(
  state: State,
  now: number,
  assets: ReturnType<typeof nativeMotionAssets>,
): boolean {
  const missing = assets.filter((a) => !state.assets[a.hash]);
  if (
    assets.some(
      (a) =>
        state.assets[a.hash] &&
        (state.assets[a.hash].data !== a.data ||
          state.assets[a.hash].type !== a.type ||
          state.assets[a.hash].bytes !== a.bytes),
    )
  )
    return false;
  // Use the same reference/LRU policy as producer uploads. Plan atomically:
  // failure must not discard cached assets, and existing motion assets stay.
  const plan = { ...state.assets },
    pinned = referencedHashes(state),
    missingBytes = missing.reduce((n, a) => n + a.bytes, 0);
  for (const asset of assets) pinned.add(asset.hash);
  while (
    Object.keys(plan).length + missing.length > 64 ||
    Object.values(plan).reduce((n, a) => n + a.bytes, 0) + missingBytes >
      4 * 1024 * 1024
  ) {
    const evict = Object.values(plan)
      .filter((a) => !pinned.has(a.hash))
      .sort((a, b) => a.usedAt - b.usedAt)[0];
    if (!evict) return false;
    delete plan[evict.hash];
  }
  for (const asset of assets)
    plan[asset.hash] = {
      ...asset,
      owners: state.assets[asset.hash]?.owners ?? [],
      usedAt: now,
    };
  state.assets = plan;
  return true;
}

/** Counts only: diagnostics never include content, asset hashes or item keys. */
export function nativeMotionCapacity(
  state: State,
  pins: Set<number>,
  assets = nativeMotionAssets(),
) {
  return {
    cachedAssets: Object.keys(state.assets).length,
    cachedAssetBytes: Object.values(state.assets).reduce(
      (n, a) => n + a.bytes,
      0,
    ),
    missingMotionAssets: assets.filter((a) => !state.assets[a.hash]).length,
    slotCount: state.slots.length,
    slotBytes: state.slots.reduce((n, s) => n + s.bytes, 0),
    pinnedSlotCount: pins.size,
    reusableAnimationSlots: state.slots.filter((s) => !pins.has(s.slot)).length,
  };
}

/** Reuse existing unpinned filenames; bicycle0 loading is suffix independent. */
export function reuseNativeMotionSlots(
  state: State,
  pins: Set<number>,
  assets = nativeMotionAssets(),
): boolean {
  const plan = state.slots.map((slot) => ({ ...slot }));
  const reserved = new Set(pins);
  for (const asset of assets) {
    let slot = plan.find((value) => value.hash === asset.hash);
    if (!slot) {
      slot = plan.find(
        (value) => value.type === "anim" && !reserved.has(value.slot),
      );
      slot ??= plan.find((value) => !reserved.has(value.slot));
      if (!slot) return false;
      Object.assign(slot, {
        hash: asset.hash,
        bytes: asset.bytes,
        uploaded: false,
      });
    }
    reserved.add(slot.slot);
  }
  if (plan.reduce((n, slot) => n + slot.bytes, 0) > 2 * 1024 * 1024)
    return false;
  state.slots = plan;
  return true;
}

/** Separate IDs avoid a same-ID XPM/animation type change on capacity fallback. */
export function nativeMotionElements(motionId = 0): Element[] {
  // Load the larger back player first, then front. Two native instances avoid
  // the observed incomplete back coverage of four independently loaded strips.
  return (["back", "front"] as const).map((display) => ({
    // A same source path cannot restart a finished firmware player. A fresh
    // widget per exit also works before old transparent masks retire.
    id: PREFIX + "native-" + motionId + "-" + display,
    type: "animation",
    display,
    x: 0,
    y: 0,
    z_index: 255,
    opacity: 100,
    assetHash: NATIVE_HASHES[display],
    section: "fade",
    loop: false,
    await_previous_end: false,
  }));
}

export function unmaskMotionElement(element: Element): Element {
  return {
    ...element,
    opacity: 0,
  };
}
