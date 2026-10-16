import { describe, expect, it } from "vitest";
import {
  createState,
  registerService,
  snapshot as makeSnapshot,
} from "../src/model";
import type { QueueItem, Snapshot } from "../ui/api";
import { queuePlayback, receivedTime } from "../ui/queue-playback";

const now = 1_800_000_000_000;
const item = (key: string, serviceId = "first"): QueueItem =>
  ({
    itemKey: key,
    serviceId,
    receivedAt: now,
    playback: {
      totalMs: 10_000,
      remainingMs: 8_000,
      running: true,
      validUntil: now + 5_000,
      startsAt: now,
    },
  }) as QueueItem;
const fixture = (): Snapshot => {
  const state = createState("device");
  for (const [id, priority] of [
    ["first", 90],
    ["second", 20],
  ] as const) {
    registerService(
      state,
      { id, name: id, template: "notifier" },
      "hash",
      "epoch",
      now,
    );
    state.services[id].config.priority = priority;
  }
  return {
    ...makeSnapshot(state, now),
    serverNow: now,
    generation: 3,
    health: {
      status: "healthy",
      confirmedValidUntil: now + 5_000,
      lastSuccessAt: now,
    },
    displaying: {
      itemKey: "owner",
      generation: 3,
      confirmedAt: now,
      confirmedValidUntil: now + 5_000,
    },
    items: [item("owner")],
  };
};

describe("confirmed queue playback", () => {
  it("uses real finite total and remaining time anchored to server time", () => {
    const state = fixture();
    const result = queuePlayback(state, ["owner"], state.items[0], 1_500);
    expect(result.current).toBe(true);
    expect(result.remainingMs).toBe(6_500);
    expect(result.progress).toBe(35);
    expect(result).not.toHaveProperty("priority");
  });

  it("keeps source and legacy unknown totals indeterminate without a countdown", () => {
    for (const remainingMs of [null, 8_000]) {
      const state = fixture();
      state.items[0].playback.totalMs = null;
      state.items[0].playback.remainingMs = remainingMs;
      const result = queuePlayback(state, ["owner"], state.items[0], 1_000);
      expect(result.current).toBe(true);
      expect(result.progress).toBeNull();
      expect(result.remainingMs).toBeNull();
    }
  });

  it("does not advance or label a preempted item as currently playing", () => {
    const state = fixture();
    state.items[0].playback.running = false;
    const result = queuePlayback(state, ["owner"], state.items[0], 1_500);
    expect(result.current).toBe(false);
    expect(result.progress).toBeNull();
    expect(result.remainingMs).toBe(8_000);
  });

  it("clears playing and progress at any confirmation expiry", () => {
    for (const expire of ["playback", "health", "displaying"] as const) {
      const state = fixture();
      if (expire === "playback") state.items[0].playback.validUntil = now + 100;
      else if (expire === "health")
        state.health.confirmedValidUntil = now + 100;
      else state.displaying!.confirmedValidUntil = now + 100;
      const result = queuePlayback(state, ["owner"], state.items[0], 100);
      expect(result.current).toBe(false);
      expect(result.progress).toBeNull();
      expect(result.remainingMs).toBe(8_000);
    }
  });

  it("resolves the active group member over the representative", () => {
    const state = fixture();
    const representative = item("representative", "second");
    representative.playback.running = false;
    state.items.push(representative);
    const active = queuePlayback(
      state,
      ["representative", "owner"],
      representative,
      0,
    );
    expect(active.item.itemKey).toBe("owner");

    expect(active.current).toBe(true);
    const waiting = queuePlayback(state, ["representative"], representative, 0);
    expect(waiting.item.itemKey).toBe("representative");

    expect(waiting.current).toBe(false);
  });

  it("requires healthy confirmation for the current generation", () => {
    const state = fixture();
    state.health.status = "blocked";
    expect(queuePlayback(state, ["owner"], state.items[0], 0).current).toBe(
      false,
    );
    state.health.status = "healthy";
    state.displaying!.generation = 2;
    expect(queuePlayback(state, ["owner"], state.items[0], 0).current).toBe(
      false,
    );
  });

  it("clamps monotonic elapsed and finite progress to their real bounds", () => {
    const state = fixture();
    expect(queuePlayback(state, ["owner"], state.items[0], -100).progress).toBe(
      20,
    );
    state.items[0].playback.remainingMs = 100;
    expect(queuePlayback(state, ["owner"], state.items[0], 200).progress).toBe(
      100,
    );
    expect(
      queuePlayback(state, ["owner"], state.items[0], 200).remainingMs,
    ).toBe(0);
  });

  it("waits for the entry animation before consuming the visible playback budget", () => {
    const state = fixture();
    state.items[0].playback.remainingMs = 10_000;
    state.items[0].playback.startsAt = now + 1_000;
    const entering = queuePlayback(state, ["owner"], state.items[0], 500);
    expect(entering.current).toBe(true);
    expect(entering.progress).toBe(0);
    expect(entering.remainingMs).toBe(10_000);
    const visible = queuePlayback(state, ["owner"], state.items[0], 1_500);
    expect(visible.progress).toBe(5);
    expect(visible.remainingMs).toBe(9_500);
  });

  it("only subtracts new elapsed time when the server already accounted for visible playback", () => {
    const state = fixture();
    state.items[0].playback.startsAt = now - 2_000;
    const result = queuePlayback(state, ["owner"], state.items[0], 500);
    expect(result.remainingMs).toBe(7_500);
    expect(result.progress).toBe(25);
  });

  it("keeps older rollout snapshots usable without inventing playback", () => {
    for (const missing of ["serverNow", "playback", "startsAt"] as const) {
      const state = fixture();
      const target =
        missing === "serverNow"
          ? state
          : missing === "playback"
            ? state.items[0]
            : state.items[0].playback;
      delete (target as unknown as Record<string, unknown>)[missing];
      const result = queuePlayback(state, ["owner"], state.items[0], 500);
      expect(result.current).toBe(false);
      expect(result.progress).toBeNull();
      expect(result.item.itemKey).toBe("owner");
    }
  });
});

describe("queue receipt time", () => {
  it("shows hour, minute and second without a 12-hour suffix", () => {
    const receipt = new Date(2026, 9, 15, 13, 4, 5).getTime();
    expect(receivedTime(receipt)).toBe("13:04:05");
  });
});
