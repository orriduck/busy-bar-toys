import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptDisplay,
  createState,
  finishItem,
  publish,
  registerService,
  validateElements,
} from "../src/model";
import {
  BLACK_MS,
  FADE_MS,
  ServiceMotionClock,
  isMotionElement,
  motionElements,
  motionOpacity,
  nativeFadeAsset,
  nativeMotionAssets,
  nativeMotionElements,
  reuseNativeMotionSlots,
  cacheNativeMotionAssets,
  nativeMotionCapacity,
  waitForMotionFence,
  unmaskMotionElement,
  type ServiceMotion,
} from "../src/service-motion";
import { digest } from "../src/security";

afterEach(() => vi.useRealTimers());

describe("local motion fence wakeups", () => {
  function fence(phase: "fade" | "black" = "fade") {
    const state = createState("local-fence");
    state.serviceMotion = {
      id: 7,
      phase,
      elapsedMs: 0,
      nativeStarted: phase === "fade",
    };
    state.commands = [
      {
        id: 1,
        generation: state.generation,
        kind: "motion",
        motionId: 7,
        dueAt: 0,
        status: "pending",
        attempts: 0,
      },
    ];
    return state;
  }

  it.each(["fade", "black"] as const)(
    "waits the remaining %s fence without completing at 199ms",
    async (phase) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const state = fence(phase),
        clock = new ServiceMotionClock(() => Date.now());
      let result: string | undefined;
      const pending = waitForMotionFence(state, clock, () => state).then(
        (value) => (result = value),
      );
      await vi.advanceTimersByTimeAsync(199);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(result).toBe("ready");
      expect(state.serviceMotion?.phase).toBe(phase); // Caller alone advances phases.
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("waits only the persisted remaining budget, and does not treat an early wake as proof", async () => {
    const state = fence();
    state.serviceMotion!.elapsedMs = 75;
    const wait = vi.fn(async (_milliseconds: number) => {});
    expect(
      await waitForMotionFence(
        state,
        new ServiceMotionClock(() => 0),
        () => state,
        wait,
      ),
    ).toBe("pending");
    expect(wait).toHaveBeenCalledExactlyOnceWith(125);
  });

  it.each(["generation", "motion", "phase", "failure"])(
    "reloads after the timer and rejects a changed %s",
    async (change) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const expected = fence(),
        live = structuredClone(expected),
        clock = new ServiceMotionClock(() => Date.now());
      const pending = waitForMotionFence(expected, clock, () => live);
      await vi.advanceTimersByTimeAsync(100);
      if (change === "generation") live.generation++;
      if (change === "motion") live.serviceMotion!.id++;
      if (change === "phase") live.serviceMotion!.phase = "black";
      if (change === "failure") live.commands[0].attempts++;
      const changed = structuredClone(live);
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toBe("changed");
      expect(live).toEqual(changed);
    },
  );

  it("does not wait on an unacknowledged fade or a failed request retry", async () => {
    const state = fence(),
      clock = new ServiceMotionClock(() => 0),
      wait = vi.fn(async () => {});
    state.serviceMotion!.nativeStarted = false;
    expect(await waitForMotionFence(state, clock, () => state, wait)).toBe(
      "pending",
    );
    state.serviceMotion!.nativeStarted = true;
    state.commands[0].attempts = 1;
    expect(await waitForMotionFence(state, clock, () => state, wait)).toBe(
      "pending",
    );
    expect(wait).not.toHaveBeenCalled();
  });
});

describe("native device fade assets", () => {
  it.each(["type", "bytes", "data"] as const)(
    "rejects a conflicting existing native asset %s without changing cache",
    (field) => {
      const state = createState("conflict"),
        asset = nativeMotionAssets()[0];
      state.assets[asset.hash] = { ...asset, owners: ["test"], usedAt: 1 };
      if (field === "type") state.assets[asset.hash].type = "png";
      if (field === "bytes") state.assets[asset.hash].bytes++;
      if (field === "data") state.assets[asset.hash].data = "eA==";
      const before = structuredClone(state.assets);
      expect(cacheNativeMotionAssets(state, 100)).toBe(false);
      expect(state.assets).toEqual(before);
    },
  );

  function fullCache(bytes = 1) {
    const state = createState("cache-capacity");
    for (let n = 0; n < 64; n++) {
      const hash = n.toString(16).padStart(64, "0");
      state.assets[hash] = {
        hash,
        type: "png",
        bytes,
        data: "eA==",
        owners: ["test"],
        usedAt: n,
      };
    }
    return state;
  }

  it("evicts only unreferenced LRU assets from a full cache for both native masks", () => {
    const state = fullCache(),
      hashes = Object.keys(state.assets);
    state.nativeElements.retained = {
      id: "retained",
      type: "image",
      assetHash: hashes[0],
    };
    state.elementExpiries.retained = {
      type: "image",
      expiresAt: Date.now() + 60_000,
    };
    expect(cacheNativeMotionAssets(state, 100)).toBe(true);
    expect(Object.keys(state.assets)).toHaveLength(64);
    expect(state.assets[hashes[0]]).toBeDefined();
    expect(state.assets[hashes[1]]).toBeUndefined();
    expect(state.assets[hashes[2]]).toBeUndefined();
    expect(
      nativeMotionAssets().every((a) => state.assets[a.hash]?.data === a.data),
    ).toBe(true);
    expect(state.slots).toEqual([]);
  });

  it("obeys the cache byte budget as well as the asset count", () => {
    const state = fullCache(65536);
    expect(cacheNativeMotionAssets(state, 100)).toBe(true);
    expect(
      nativeMotionCapacity(state, new Set()).cachedAssetBytes,
    ).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(Object.keys(state.assets)).toHaveLength(64);
  });

  it("leaves a referenced full cache unchanged when both masks cannot fit", () => {
    const state = fullCache();
    for (const [n, hash] of Object.keys(state.assets).entries()) {
      if (n === 63) continue; // One evictable entry is insufficient for two masks.
      const id = "retained-" + n;
      state.nativeElements[id] = { id, type: "image", assetHash: hash };
      state.elementExpiries[id] = {
        type: "image",
        expiresAt: Date.now() + 60_000,
      };
    }
    const before = structuredClone(state.assets);
    expect(cacheNativeMotionAssets(state, 100)).toBe(false);
    expect(state.assets).toEqual(before);
  });

  it("does not evict an existing native mask while caching its missing peer", () => {
    const state = fullCache(),
      asset = nativeMotionAssets()[0];
    delete state.assets[Object.keys(state.assets)[63]];
    state.assets[asset.hash] = { ...asset, owners: [], usedAt: -1 };
    expect(cacheNativeMotionAssets(state, 100)).toBe(true);
    expect(
      nativeMotionAssets().every((a) => state.assets[a.hash]?.data === a.data),
    ).toBe(true);
    expect(Object.keys(state.assets)).toHaveLength(64);
  });

  it("matches the hardware-preview bytes, seven time samples and transparent clear section", async () => {
    for (const [width, height, hash, length] of [
      [
        72,
        16,
        "27e262da8497b418e4c763d30d699e9c6e5fc030546e6fac27a7c758271fd266",
        526,
      ],
      [
        160,
        80,
        "3760f789e7c4639656e0eec53518385c3c9379e8819a86061ed152fd83b12103",
        4166,
      ],
    ] as const) {
      const raw = nativeFadeAsset(width, height),
        view = new DataView(raw.buffer);
      expect(raw.length).toBe(length);
      expect(await digest(raw)).toBe(hash);
      expect(new TextDecoder().decode(raw.slice(0, 8))).toBe("bicycle0");
      expect([raw[9], raw[10], raw[11], raw[12]]).toEqual([
        width,
        height,
        2,
        30,
      ]);
      expect(view.getUint32(16, true)).toBe(58);
      expect(view.getUint32(28, true)).toBe(8);
      // Independent reference decoder checks every pixel, including the final
      // short run. Hash equality also ties these bytes to the device preview.
      const alphas = [1, 19, 66, 128, 189, 236, 255, 0];
      let frameOffset = 94;
      for (const alpha of alphas) {
        expect(raw[frameOffset]).toBe(1); // RLE
        expect(raw[frameOffset + 1]).toBe(1);
        const size = view.getUint16(frameOffset + 2, true);
        const decoded: number[] = [];
        for (let p = frameOffset + 4; p < frameOffset + 4 + size; p += 5) {
          expect(raw[p]).toBeGreaterThan(0);
          expect(raw[p]).toBeLessThanOrEqual(127);
          expect(raw[p] & 128).toBe(0);
          for (let n = 0; n < raw[p]; n++)
            decoded.push(...raw.slice(p + 1, p + 5));
        }
        expect(decoded).toEqual(
          Array.from({ length: width * height }, () => [0, 0, 0, alpha]).flat(),
        );
        frameOffset += 4 + size;
      }
      expect(frameOffset).toBe(raw.length);
      expect(view.getUint32(57, true)).toBe(0); // named fade starts at frame0
      expect(view.getUint32(61, true)).toBe(6); // opaque at t200ms
      expect(view.getUint32(75, true)).toBe(7); // clear section is separate
    }
  });

  it("hides same-type native widgets by opacity and gives each exit fresh IDs", () => {
    const state = createState("native-fade");
    expect(cacheNativeMotionAssets(state, 10)).toBe(true);
    expect(
      nativeMotionAssets().every(
        (a) => a.bytes < 262144 && state.assets[a.hash].owners.length === 0,
      ),
    ).toBe(true);
    const fade = nativeMotionElements(),
      clear = fade.map(unmaskMotionElement);
    expect(fade.map((e) => e.display)).toEqual(["back", "front"]);
    expect(
      fade.every(
        (e) =>
          e.type === "animation" &&
          e.section === "fade" &&
          e.loop === false &&
          e.await_previous_end === false,
      ),
    ).toBe(true);
    expect(
      clear.every(
        (e, n) =>
          e.id === fade[n].id &&
          e.type === fade[n].type &&
          e.assetHash === fade[n].assetHash &&
          e.section === "fade" &&
          e.opacity === 0,
      ),
    ).toBe(true);
    expect(
      new Set(fade.filter((e) => e.display === "back").map((e) => e.assetHash))
        .size,
    ).toBe(1);
    const next = nativeMotionElements(12),
      previous = nativeMotionElements(11);
    expect(next.every((e) => !previous.some((old) => old.id === e.id))).toBe(
      true,
    );
    expect(next.map((e) => e.assetHash)).toEqual(
      previous.map((e) => e.assetHash),
    );
  });

  it("reuses only historical unpinned animation slots without fragmenting PNG-only history", () => {
    const state = createState("native-fade");
    expect(reuseNativeMotionSlots(state, new Set())).toBe(false);
    expect(state.slots).toEqual([]);
    state.slots = Array.from({ length: 16 }, (_, slot) => ({
      slot,
      hash: String(slot),
      type: "png",
      bytes: 1,
      uploaded: true,
    }));
    const previous = structuredClone(state.slots);
    expect(reuseNativeMotionSlots(state, new Set())).toBe(false);
    expect(state.slots).toEqual(previous);
    state.slots[3].type = "anim";
    state.slots[4].type = "anim";
    expect(reuseNativeMotionSlots(state, new Set([3]))).toBe(false);
    expect(reuseNativeMotionSlots(state, new Set())).toBe(true);
    expect(state.slots).toHaveLength(16);
    expect(
      state.slots.filter((s) => s.type === "anim").map((s) => s.slot),
    ).toEqual([3, 4]);
    expect(
      new Set(state.slots.filter((s) => s.type === "anim").map((s) => s.hash)),
    ).toEqual(new Set(nativeMotionAssets().map((a) => a.hash)));
  });
});

describe("shared service exit timeline", () => {
  it("samples 199/200ms fade and 399/400ms total boundaries from elapsed time", () => {
    let now = 0;
    const clock = new ServiceMotionClock(() => now);
    const motion: ServiceMotion = { id: 1, phase: "fade", elapsedMs: 0 };
    expect(motionOpacity(clock.elapsed(motion))).toBe(0);
    now = 199;
    expect(motionOpacity(clock.elapsed(motion))).toBe(99);
    now = 200;
    expect(motionOpacity(clock.elapsed(motion))).toBe(100);
    // The dispatcher enters this phase only after the opaque native ACK.
    motion.phase = "black";
    motion.elapsedMs = 0;
    clock.elapsed(motion);
    now = 399;
    expect(clock.elapsed(motion)).toBe(BLACK_MS - 1);
    now = 400;
    expect(clock.elapsed(motion)).toBe(BLACK_MS);
  });

  it("skips missed samples instead of replaying frames or accumulating frame counts", () => {
    let now = 10;
    const clock = new ServiceMotionClock(() => now);
    const motion: ServiceMotion = { id: 1, phase: "fade", elapsedMs: 0 };
    clock.elapsed(motion);
    now = 190;
    expect(motionOpacity(clock.elapsed(motion))).toBe(90);
    now = 800;
    expect(motionOpacity(clock.elapsed(motion))).toBe(100);
    expect(motion.elapsedMs).toBe(790);
    expect(FADE_MS).toBe(200);
  });

  it("never reverses on a backwards clock sample and resumes persisted progress", () => {
    let now = 40;
    const clock = new ServiceMotionClock(() => now);
    const motion: ServiceMotion = { id: 1, phase: "fade", elapsedMs: 75 };
    expect(clock.elapsed(motion)).toBe(75);
    now = 80;
    expect(clock.elapsed(motion)).toBe(115);
    now = 50;
    expect(clock.elapsed(motion)).toBe(115);
    const restarted = new ServiceMotionClock(() => 1);
    expect(restarted.elapsed(motion)).toBe(115);
  });

  it("covers the full 72x16 front and 160x80 back above native scrolling text", () => {
    const masks = motionElements(65);
    expect(validateElements(masks)).toEqual(masks);
    expect(masks).toHaveLength(5);
    expect(
      masks.every(
        (e) =>
          isMotionElement(e.id) &&
          e.type === "xpmbitmap" &&
          e.opacity === 65 &&
          Number(e.z_index) > 35,
      ),
    ).toBe(true);
    expect(masks.filter((e) => e.display === "back").map((e) => e.y)).toEqual([
      0, 20, 40, 60,
    ]);
    expect(masks.every((e) => String(e.data).includes("B c #000000"))).toBe(
      true,
    );
    expect(motionElements(100).every((e) => e.opacity === 100)).toBe(true);
  });
});

const start = 1_800_000_000_000;
function fixture() {
  const s = createState("motion-test");
  for (const id of ["normal", "urgent"])
    registerService(
      s,
      {
        id,
        name: id,
        template: "notifier",
        ...(id === "urgent" ? { priorityGroup: "interception" } : {}),
      },
      "hash",
      "epoch",
      start,
    );
  return s;
}
function item(id: string, level = "info", version = 1) {
  return {
    instanceId: "mac",
    epoch: "epoch",
    itemId: id,
    version,
    firstRecognizedAt: start,
    kind: "event",
    level,
    title: id,
    detail: "",
    validUntil: start + 100_000,
    scene: {
      entryDurationMs: 0,
      commands: [
        {
          offsetMs: 0,
          elements: [{ id: "view", type: "text", text: id, font: "small" }],
        },
      ],
    },
  };
}
function native(s: ReturnType<typeof fixture>) {
  s.nativeElements.view = {
    id: "view",
    type: "text",
    text: "old high text",
    font: "small",
    z_index: 35,
  };
  s.elementExpiries.view = { type: "text", expiresAt: start + 60_000 };
  s.commands = [];
}

describe("service motion scheduling", () => {
  it("does not animate cold start or delay an empty clear with a new exit", () => {
    const s = fixture();
    publish(s, "normal", item("one"), start);
    expect(s.serviceMotion).toBeUndefined();
    expect(s.commands.map((c) => c.kind)).toEqual(["clear", "draw"]);
    native(s);
    finishItem(s, s.selected!, "resolved", 1, start + 1);
    expect(s.selected).toBeNull();
    expect(s.commands.map((c) => c.kind)).toEqual(["clear"]);
    expect(s.serviceMotion).toBeUndefined();
  });

  it("keeps the original exit and elapsed progress during urgent candidate churn", () => {
    const s = fixture();
    publish(s, "normal", item("one"), start);
    acceptDisplay(s, s.generation, start);
    native(s);
    publish(s, "urgent", item("two", "urgent"), start + 100);
    const motion = s.serviceMotion!;
    motion.elapsedMs = 150;
    finishItem(s, s.selected!, "resolved", 1, start + 150);
    publish(s, "urgent", item("three", "urgent"), start + 180);
    expect(s.serviceMotion).toBe(motion);
    expect(s.serviceMotion?.elapsedMs).toBe(150);
    expect(s.items[s.selected!].itemId).toBe("three");
    expect(s.commands.filter((c) => c.kind === "motion")).toHaveLength(1);
    expect(s.items[JSON.stringify(["normal", "mac", "one"])].remainingMs).toBe(
      9900,
    );
    expect(s.displaying).toBeNull();
  });

  it("does not reset an exit or the generation when the selected item updates", () => {
    const s = fixture();
    publish(s, "normal", item("one"), start);
    native(s);
    publish(s, "urgent", item("two", "urgent"), start + 1);
    const motion = s.serviceMotion!;
    motion.phase = "black";
    motion.elapsedMs = 180;
    const generation = s.generation;
    publish(s, "urgent", item("two", "urgent", 2), start + 5);
    expect(s.generation).toBe(generation);
    expect(s.serviceMotion).toBe(motion);
    expect(s.serviceMotion?.elapsedMs).toBe(180);
  });

  it("does not start another exit while opaque handoff masks remain", () => {
    const s = fixture();
    publish(s, "normal", item("one"), start);
    native(s);
    publish(s, "urgent", item("two", "urgent"), start + 1);
    const id = s.serviceMotion!.id;
    s.serviceMotion!.phase = "handoff";
    finishItem(s, s.selected!, "resolved", 1, start + 2);
    expect(s.serviceMotion?.id).toBe(id);
    expect(s.commands.some((c) => c.kind === "motion")).toBe(false);
    expect(s.items[s.selected!].itemId).toBe("one");
  });

  it("starts a fresh bounded exit when transparent handoff masks prove the incoming view is visible", () => {
    const s = fixture();
    publish(s, "normal", item("one"), start);
    native(s);
    publish(s, "urgent", item("two", "urgent"), start + 1);
    const oldId = s.serviceMotion!.id;
    s.serviceMotion!.phase = "handoff";
    for (const e of motionElements(0)) {
      s.nativeElements[e.id] = e;
      s.elementExpiries[e.id] = { type: "xpmbitmap", expiresAt: start + 60000 };
    }
    finishItem(s, s.selected!, "resolved", 1, start + 2);
    expect(s.serviceMotion?.phase).toBe("fade");
    expect(s.serviceMotion?.id).not.toBe(oldId);
    const fresh = s.serviceMotion!;
    fresh.elapsedMs = 125;
    publish(s, "urgent", item("three", "urgent"), start + 3);
    expect(s.serviceMotion).toBe(fresh);
    expect(s.serviceMotion?.elapsedMs).toBe(125);
  });
});
