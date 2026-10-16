import { describe, expect, it } from "vitest";
import {
  createState,
  registerService,
  snapshot as makeSnapshot,
} from "../src/model";
import type { Snapshot, QueueItem } from "../ui/api";
import { queueLayout, queuePresence, queueExitMs } from "../ui/queue-layout";
import { sourceRouteCommand } from "../ui/service-setup";

const now = 1_800_000_000_000;
function fixture(): Snapshot {
  const state = createState("device");
  for (const id of ["codex", "claude", "notify"])
    registerService(
      state,
      { id, name: id, template: id === "notify" ? "notifier" : "agent" },
      "hash",
      "epoch",
      now,
    );
  const items = ["codex", "claude", "notify"].map((id) => ({
    itemKey: id,
    serviceId: id,
    instanceId: id,
    app: id,
    state: "waiting",
    receivedAt: now,
    playback: {
      totalMs: 10_000,
      remainingMs: 8_000,
      running: id === "claude",
      validUntil: now + 5_000,
      startsAt: now,
    },
  })) as QueueItem[];
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
      itemKey: "claude",
      generation: 3,
      confirmedAt: now,
      confirmedValidUntil: now + 5_000,
    },
    items,
    groups: items.map((item, order) => ({
      groupId: item.itemKey,
      memberKeys: [item.itemKey],
      representative: item.itemKey,
      level: "info",
      order,
      serviceId: item.serviceId,
    })),
  };
}

describe("queue presentation preserves scheduling authority", () => {
  it("leads with only the confirmed owner and keeps all other server order", () => {
    const state = fixture();
    const rows = queueLayout(state);
    expect(rows.map((r) => r.groupId)).toEqual(["claude", "codex", "notify"]);
    expect(rows.filter((r) => r.current).map((r) => r.item.itemKey)).toEqual([
      "claude",
    ]);
    // Progress reaching zero never elects the next player.
    expect(
      queueLayout(state, 4_999)
        .filter((r) => r.current)
        .map((r) => r.item.itemKey),
    ).toEqual(["claude"]);
    const expired = queueLayout(state, 5_000);
    expect(expired.every((r) => !r.current && r.progress === null)).toBe(true);
    expect(expired.map((r) => r.groupId)).toEqual([
      "codex",
      "claude",
      "notify",
    ]);
  });
  it("describes rotation only for eligible different Dispensable services", () => {
    const state = fixture();
    expect(
      queueLayout(state)
        .filter((r) => r.rotating)
        .map((r) => r.item.serviceId),
    ).toEqual(["claude", "codex"]);
    state.items[1].state = "paused";
    expect(queueLayout(state).some((r) => r.rotating)).toBe(false);
    state.items[1].state = "waiting";
    state.items[1].serviceId = "codex";
    expect(queueLayout(state).some((r) => r.rotating)).toBe(false);
  });
  it("keeps all bundled members, unresolved identities and orphaned items", () => {
    const state = fixture();
    state.groups = [
      {
        ...state.groups[0],
        representative: "codex",
        memberKeys: ["codex", "claude"],
      },
    ];
    const rows = queueLayout(state);
    expect(rows).toHaveLength(2);
    expect(rows[0].memberKeys).toEqual(["codex", "claude"]);
    expect(rows[0].item.itemKey).toBe("claude");
    expect(rows[1].item.itemKey).toBe("notify");
  });
  it("does not call a selected but unconfirmed owner playing or switching", () => {
    const state = fixture();
    state.displaying = null;
    state.selected = "codex";
    state.applying = null;
    expect(queueLayout(state).some((r) => r.current || r.applying)).toBe(false);
    state.applying = "codex";
    expect(queueLayout(state).find((r) => r.applying)?.item.itemKey).toBe(
      "codex",
    );
  });
});

describe("bounded queue departures", () => {
  const incoming = (ids: string[]) => ids.map((id) => ({ id, value: id }));
  it("retains a removed row only for its original exit window", () => {
    const initial = queuePresence([], incoming(["a", "b"]), now, true);
    const removed = queuePresence(initial, incoming(["b"]), now + 1, true);
    expect(removed[0]).toEqual({
      id: "a",
      value: "a",
      until: now + 1 + queueExitMs,
    });
    const updated = queuePresence(
      removed,
      incoming(["c", "b"]),
      now + 100,
      true,
    );
    expect(updated.find((r) => r.id === "a")?.until).toBe(
      now + 1 + queueExitMs,
    );
    expect(
      queuePresence(
        updated,
        incoming(["c", "b"]),
        now + 1 + queueExitMs,
        true,
      ).map((r) => r.id),
    ).toEqual(["c", "b"]);
  });
  it("cancels departures on reappearance without duplicate rows", () => {
    const initial = queuePresence([], incoming(["a", "b"]), now, true);
    const removed = queuePresence(initial, incoming(["b"]), now + 1, true);
    expect(queuePresence(removed, incoming(["b", "a"]), now + 2, true)).toEqual(
      [
        { id: "b", value: "b", until: null },
        { id: "a", value: "a", until: null },
      ],
    );
  });
  it("bounds mass removals and removes immediately when motion is disabled", () => {
    const initial = queuePresence(
      [],
      incoming(Array.from({ length: 64 }, (_, i) => String(i))),
      now,
      true,
    );
    expect(queuePresence(initial, [], now + 1, true)).toHaveLength(12);
    expect(queuePresence(initial, [], now + 1, false)).toEqual([]);
  });
});

describe("sender setup command", () => {
  it("matches the local route identifier rules and rejects shell syntax", () => {
    expect(sourceRouteCommand("codex", "service-id")).toBe(
      "busy-bar cloud-route codex service-id",
    );
    expect(sourceRouteCommand("my app", "id")).toBeNull();
    expect(sourceRouteCommand("it's `a` $(source)", "id")).toBeNull();
    expect(sourceRouteCommand("__proto__", "id")).toBeNull();
    expect(sourceRouteCommand("codex", "constructor")).toBeNull();
    expect(sourceRouteCommand(" ", "id")).toBeNull();
    expect(sourceRouteCommand("a\nb", "id")).toBeNull();
    expect(sourceRouteCommand("\nabc", "id")).toBeNull();
    expect(sourceRouteCommand("--source", "id")).toBe(
      "busy-bar cloud-route -- --source id",
    );
  });
});
