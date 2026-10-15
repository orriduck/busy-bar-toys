import { describe, it, expect } from "vitest";
import {
  createState,
  registerService,
  publish,
  tick,
  acceptDisplay,
  finishItem,
  patchConfig,
  input,
  snapshot,
  actionResult,
  requestAction,
} from "../src/model";
const now = 1_800_000_000_000;
const p = (id: string, extra: Record<string, unknown> = {}) => ({
  instanceId: "mac",
  epoch: "epoch",
  itemId: id,
  version: 1,
  firstRecognizedAt: now,
  kind: "event",
  level: "info",
  title: id,
  detail: "private " + id,
  validUntil: now + 100_000,
  scene: {
    entryDurationMs: 1000,
    commands: [
      {
        offsetMs: 0,
        elements: [{ id: "t", type: "text", text: id, font: "small" }],
      },
    ],
  },
  ...extra,
});
function state() {
  const s = createState("device");
  registerService(
    s,
    { id: "a", name: "A", template: "notifier", config: {} },
    "hash",
    "epoch",
    now,
  );
  registerService(
    s,
    { id: "b", name: "B", template: "notifier", config: {} },
    "hash",
    "epoch",
    now,
  );
  return s;
}
describe("v5 scheduling", () => {
  it("urgent FIFO does not preempt current urgent even with earlier timestamp and higher priority", () => {
    const s = state();
    publish(s, "a", p("one", { level: "urgent" }), now);
    const key = s.selected!;
    acceptDisplay(s, s.generation, now);
    publish(
      s,
      "b",
      p("two", { level: "urgent", firstRecognizedAt: now - 1000 }),
      now + 1,
    );
    expect(s.selected).toBe(key);
    finishItem(s, key, "resolved", 1, now + 2);
    expect(s.items[s.selected!].itemId).toBe("two");
  });
  it("pauses finite visible time under preemption and resumes latest scene without resetting duration", () => {
    const s = state();
    publish(s, "a", p("one"), now);
    acceptDisplay(s, s.generation, now);
    tick(s, now + 4000);
    publish(s, "b", p("urgent", { level: "urgent" }), now + 4000);
    expect(s.items[JSON.stringify(["a", "mac", "one"])].remainingMs).toBe(7000);
    finishItem(s, s.selected!, "resolved", 1, now + 5000);
    acceptDisplay(s, s.generation, now + 5000);
    tick(s, now + 13001);
    expect(Object.values(s.items)).toHaveLength(0);
  });
  it("condition snoozes with stable identity and heartbeats do not shift wake time", () => {
    const s = state();
    publish(
      s,
      "a",
      p("c", { kind: "condition", validUntil: now + 86400000 }),
      now,
    );
    acceptDisplay(s, s.generation, now);
    tick(s, now + 11001);
    const item = Object.values(s.items)[0];
    expect(item.state).toBe("snoozed");
    const wake = item.nextEligibleAt;
    publish(
      s,
      "a",
      p("c", { kind: "condition", version: 2, validUntil: now + 86400000 }),
      now + 12000,
    );
    expect(item.nextEligibleAt).toBe(wake);
  });
  it("dedupes identities and tombstones clear every nonurgent state without resurrection", () => {
    const s = state();
    publish(s, "a", p("one"), now);
    publish(s, "a", p("one"), now + 1);
    publish(s, "b", p("two"), now + 2);
    const gen = s.generation;
    input(s, "button", gen, now + 3);
    expect(Object.values(s.items)).toHaveLength(0);
    expect(() => publish(s, "a", p("one", { version: 2 }), now + 4)).toThrow(
      "ITEM_ENDED",
    );
    expect(input(s, "button", gen, now + 4).duplicate).toBe(true);
  });
  it("groups preserve every member and old admission completion does not clear late member", () => {
    const s = state();
    publish(s, "a", p("one", { groupKey: "g" }), now);
    acceptDisplay(s, s.generation, now);
    publish(s, "a", p("two", { groupKey: "g" }), now + 2000);
    expect(snapshot(s, now + 2000).groups).toHaveLength(1);
    tick(s, now + 11001);
    expect(Object.values(s.items).map((i) => i.itemId)).toEqual(["two"]);
  });
  it("revisions conflict and disabled items end", () => {
    const s = state();
    publish(s, "a", p("one"), now);
    expect(() => patchConfig(s, "a", { enabled: false }, 0, now)).toThrow(
      "CONFIG_CONFLICT",
    );
    patchConfig(s, "a", { enabled: false }, s.configRevision, now);
    expect(s.selected).toBeNull();
    expect(Object.values(s.items)).toHaveLength(0);
  });
  it("success is original-version bound and producer snapshots hide other bodies", () => {
    const s = state();
    publish(
      s,
      "a",
      p("one", { level: "urgent", actionKeys: ["primary"] }),
      now,
    );
    acceptDisplay(s, s.generation, now);
    const action = requestAction(
      s,
      {
        requestId: "r",
        itemKey: s.selected!,
        generation: s.generation,
        actionKey: "primary",
      },
      now,
    );
    publish(
      s,
      "a",
      p("one", { version: 2, level: "urgent", actionKeys: ["primary"] }),
      now + 1,
    );
    actionResult(s, action.id, "succeeded", now + 2);
    expect(s.selected).not.toBeNull();
    publish(s, "b", p("two"), now + 3);
    const view = JSON.stringify(snapshot(s, now + 4, "a"));
    expect(view).not.toContain("private two");
    expect(view).not.toContain('"title":"two"');
  });
  it("only current healthy urgent confirmation grants finite queue proof", () => {
    const s = state();
    publish(s, "a", p("one", { level: "urgent" }), now);
    publish(s, "b", p("two", { level: "urgent" }), now);
    expect(
      snapshot(s, now).items.find((i) => i.serviceId === "b")?.queueProof,
    ).toBeUndefined();
    acceptDisplay(s, s.generation, now);
    expect(
      snapshot(s, now + 1000).items.find((i) => i.serviceId === "b")?.queueProof
        ?.validUntil,
    ).toBeGreaterThan(now);
    expect(
      snapshot(s, now + 61000).items.find((i) => i.serviceId === "b")
        ?.queueProof,
    ).toBeUndefined();
  });
});
describe("state boundary regressions", () => {
  it("paused members and snoozed members remain in snapshot group membership", () => {
    const s = state();
    publish(s, "a", p("one", { groupKey: "g" }), now);
    publish(s, "a", p("two", { groupKey: "g" }), now);
    s.items[JSON.stringify(["a", "mac", "two"])].state = "paused";
    const group = snapshot(s, now).groups[0];
    expect(group.memberKeys).toHaveLength(2);
  });
  it("same-group admitted urgent members get bounded own-version display coverage", () => {
    const s = state();
    publish(s, "a", p("one", { groupKey: "g", level: "urgent" }), now);
    publish(s, "a", p("two", { groupKey: "g", level: "urgent" }), now);
    s.admission.push({
      itemKey: JSON.stringify(["a", "mac", "two"]),
      version: 1,
    });
    acceptDisplay(s, s.generation, now);
    const item = snapshot(s, now + 1).items.find((i) => i.itemId === "two");
    expect(item?.coverageProof?.version).toBe(1);
    expect(item?.actionKeys).toEqual([]);
    expect(item?.source.connected).toBe(true);
  });
  it("explicit finite urgent completes and default urgent persists until source ends", () => {
    const s = state();
    patchConfig(s, "a", { exit: "finite" }, s.configRevision, now);
    publish(s, "a", p("one", { level: "urgent" }), now);
    expect(s.items[s.selected!].remainingMs).toBe(10000);
    acceptDisplay(s, s.generation, now);
    tick(s, now + 11001);
    expect(s.selected).toBeNull();
  });
  it("late unknown action authoritative success can resolve original target", () => {
    const s = state();
    publish(
      s,
      "a",
      p("one", { level: "urgent", actionKeys: ["primary"] }),
      now,
    );
    const key = s.selected!;
    const a = requestAction(
      s,
      {
        requestId: "r",
        itemKey: key,
        generation: s.generation,
        actionKey: "primary",
      },
      now,
    );
    tick(s, now + 31000);
    expect(a.status).toBe("unknown");
    actionResult(s, a.id, "succeeded", now + 32000);
    expect(s.items[key]).toBeUndefined();
  });
  it("expired pending action cannot begin execution late", () => {
    const s = state();
    publish(
      s,
      "a",
      p("one", { level: "urgent", actionKeys: ["primary"] }),
      now,
    );
    const a = requestAction(
      s,
      {
        requestId: "r",
        itemKey: s.selected!,
        generation: s.generation,
        actionKey: "primary",
      },
      now,
    );
    expect(() => actionResult(s, a.id, "running", now + 31000)).toThrow(
      "ACTION_EXPIRED",
    );
  });
});
describe("generation admission", () => {
  it("unacknowledged representative revision receives reentry with zero remaining lifetime then terminates", () => {
    const s = state();
    publish(s, "a", p("one"), now);
    acceptDisplay(s, s.generation, now);
    const generation = s.generation;
    publish(s, "a", p("one", { version: 2, title: "Changed" }), now + 5000);
    tick(s, now + 11001);
    expect(s.generation).toBeGreaterThan(generation);
    expect(s.items[s.selected!].remainingMs).toBe(0);
    expect(s.items[s.selected!].version).toBe(2);
    const next = s.generation;
    tick(s, now + 11002);
    expect(s.generation).toBe(next);
    acceptDisplay(s, s.generation, now + 11003);
    tick(s, now + 12004);
    expect(s.selected).toBeNull();
  });
  it("same-group late urgent waits with finite queue proof instead of claiming displayed coverage", () => {
    const s = state();
    publish(s, "a", p("one", { groupKey: "g", level: "urgent" }), now);
    acceptDisplay(s, s.generation, now);
    publish(s, "a", p("two", { groupKey: "g", level: "urgent" }), now + 1);
    const i = snapshot(s, now + 2).items.find((i) => i.itemId === "two");
    expect(i?.coverageProof).toBeUndefined();
    expect(i?.queueProof?.validUntil).toBeGreaterThan(now);
  });
});

describe("optional queue provenance and preview capability", () => {
  it("retains app without changing recognition, receipt or queue order", () => {
    const s = state();
    const item = publish(s, "a", p("one", { app: "Mail" }), now);
    expect(item.app).toBe("Mail");
    const updated = publish(
      s,
      "a",
      p("one", { app: "Mail", version: 2 }),
      now + 1000,
    );
    expect(updated.receivedAt).toBe(now);
    expect(updated.enqueueSeq).toBe(item.enqueueSeq);
    expect(publish(s, "a", p("old"), now).app).toBeUndefined();
  });
  it("rejects empty, control-containing, whitespace-only, and overlong app strings", () => {
    for (const app of ["", " ", "a\n", "a".repeat(65), 1])
      expect(() => publish(state(), "a", p("one", { app }), now)).toThrow();
  });
  it("defaults allowPreview false including old config and validates admin changes", () => {
    const s = state();
    expect(s.services.a.config.allowPreview).toBe(false);
    delete (s.services.a.config as any).allowPreview;
    patchConfig(s, "a", { priority: 51 }, s.configRevision, now);
    expect(s.services.a.config.allowPreview).toBe(false);
    patchConfig(s, "a", { allowPreview: true }, s.configRevision, now);
    expect(s.services.a.config.allowPreview).toBe(true);
    expect(() =>
      patchConfig(s, "a", { allowPreview: 1 }, s.configRevision, now),
    ).toThrow();
  });
});

it("normalizes legacy service preview capability in snapshots", () => {
  const s = state();
  delete (s.services.a.config as any).allowPreview;
  expect(
    snapshot(s, now).services.find((v) => v.id === "a")!.config.allowPreview,
  ).toBe(false);
});
