import { describe, expect, it } from "vitest";
import * as model from "../src/model";

const now = 1_800_000_000_000;
function state() {
  const s = model.createState("device");
  for (const id of ["a", "b", "c"])
    model.registerService(
      s,
      { id, name: id, template: "notifier" },
      "hash",
      "epoch",
      now,
    );
  return s;
}
function publish(
  s: model.State,
  id = "one",
  extra: Record<string, unknown> = {},
  at = now,
) {
  return model.publish(
    s,
    "a",
    {
      instanceId: "mac",
      epoch: "epoch",
      itemId: id,
      version: 1,
      firstRecognizedAt: now,
      kind: "event",
      level: "info",
      title: id,
      validUntil: now + 86_400_000,
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
    },
    at,
  );
}
function itemView(s: model.State, at = now, key = s.selected!) {
  return model.snapshot(s, at).items.find((i) => i.itemKey === key)!;
}

describe("atomic service ordering", () => {
  it("sets a complete order and advances each revision only once", () => {
    const s = state(),
      before = s.revision,
      config = s.configRevision;
    model.reorderServices(s, ["c", "a", "b"], config, now);
    expect([
      s.services.c.config.priority,
      s.services.a.config.priority,
      s.services.b.config.priority,
    ]).toEqual([1000, 999, 998]);
    expect(s.revision).toBe(before + 1);
    expect(s.configRevision).toBe(config + 1);
  });
  it.each(
    [
      undefined,
      "a",
      [],
      ["a", "b"],
      ["a", "a", "c"],
      ["a", "b", "unknown"],
      ["a", "b", "c", "c"],
      ["a", "b", 3],
    ].map((ids) => ({ ids })),
  )("rejects invalid permutations without mutation: $ids", ({ ids }) => {
    const s = state(),
      before = structuredClone(s);
    expect(() => model.reorderServices(s, ids, s.configRevision, now)).toThrow(
      "INVALID_SERVICE_ORDER",
    );
    expect(s).toEqual(before);
  });
  it("rejects a concurrent config revision without mutation", () => {
    const s = state(),
      before = structuredClone(s);
    expect(() =>
      model.reorderServices(s, ["b", "a", "c"], s.configRevision - 1, now),
    ).toThrow("CONFIG_CONFLICT");
    expect(s).toEqual(before);
  });
  it("reschedules using the new order while preserving urgent precedence and one revision", () => {
    const s = state();
    const first = publish(s);
    model.publish(
      s,
      "b",
      { ...first, itemId: "two", instanceId: "mac", epoch: "epoch" },
      now,
    );
    const before = s.revision;
    model.reorderServices(s, ["b", "a", "c"], s.configRevision, now);
    expect(s.items[s.selected!].serviceId).toBe("b");
    expect(s.revision).toBe(before + 1);
    publish(s, "urgent", { level: "urgent" });
    model.reorderServices(s, ["b", "c", "a"], s.configRevision, now);
    expect(s.items[s.selected!].level).toBe("urgent");
  });
});

describe("confirmed playback metadata", () => {
  it("anchors finite totals on publication and reads elapsed playback without mutating or double accounting", () => {
    const s = state();
    publish(s);
    expect(model.snapshot(s, now).serverNow).toBe(now);
    expect(itemView(s).playback).toEqual({
      totalMs: 10000,
      remainingMs: 10000,
      running: false,
      validUntil: 0,
      startsAt: null,
    });
    model.acceptDisplay(s, s.generation, now);
    const before = structuredClone(s);
    expect(itemView(s, now + 4000).playback).toEqual({
      totalMs: 10000,
      remainingMs: 7000,
      running: true,
      validUntil: now + 60000,
      startsAt: now + 1000,
    });
    expect(s).toEqual(before);
    model.tick(s, now + 4000);
    expect(itemView(s, now + 5000).playback.remainingMs).toBe(6000);
    model.patchConfig(
      s,
      "a",
      { visibleMs: 20000 },
      s.configRevision,
      now + 5000,
    );
    publish(s, "one", { version: 2 }, now + 5000);
    expect(itemView(s, now + 5000).playback.totalMs).toBe(10000);
  });
  it("keeps source lifetime indeterminate and old finite totals unknown", () => {
    const s = state();
    const finite = publish(s);
    delete finite.originalVisibleMs;
    model.acceptDisplay(s, s.generation, now);
    expect(itemView(s, now + 2000).playback).toMatchObject({
      totalMs: null,
      remainingMs: 9000,
      running: true,
    });
    publish(s, "source", { kind: "agent", level: "urgent" });
    model.acceptDisplay(s, s.generation, now);
    expect(itemView(s, now + 2000).playback).toMatchObject({
      totalMs: null,
      remainingMs: null,
      running: true,
    });
  });
  it("reports the future entry start without running applying, covered or stale displays", () => {
    const s = state();
    const first = publish(s, "one", { groupKey: "g" });
    expect(itemView(s).playback.running).toBe(false);
    model.acceptDisplay(s, s.generation, now);
    expect(itemView(s, now + 500).playback).toMatchObject({
      running: true,
      remainingMs: 10000,
      startsAt: now + 1000,
    });
    const second = publish(s, "two", { groupKey: "g" }, now + 2000);
    expect(itemView(s, now + 2000, first.itemKey).playback.running).toBe(true);
    expect(itemView(s, now + 2000, second.itemKey).playback.running).toBe(
      false,
    );
    s.health.status = "blocked";
    expect(itemView(s, now + 2000).playback.running).toBe(false);
    s.health.status = "healthy";
    s.visibleSince = null;
    expect(itemView(s, now + 2000).playback.running).toBe(false);
  });
  it("caps elapsed playback at confirmation expiry", () => {
    const s = state();
    s.services.a.config.visibleMs = 120000;
    publish(s);
    model.acceptDisplay(s, s.generation, now);
    expect(itemView(s, now + 65000).playback).toEqual({
      totalMs: 120000,
      remainingMs: 61000,
      running: false,
      validUntil: 0,
      startsAt: now + 1000,
    });
  });
  it("uses the latest Hold only for a new host occurrence, without automatic repeat", () => {
    const s = state();
    publish(s, "condition", { kind: "condition" });
    model.acceptDisplay(s, s.generation, now);
    model.patchConfig(
      s,
      "a",
      { visibleMs: 20000 },
      s.configRevision,
      now + 5000,
    );
    model.tick(s, now + 11000);
    expect(Object.values(s.items)).toHaveLength(0);
    model.tick(s, now + 12000);
    expect(Object.values(s.items)).toHaveLength(0);
    publish(
      s,
      "new-host-occurrence",
      { kind: "condition", validUntil: now + 100000 },
      now + 12001,
    );
    expect(itemView(s, now + 12001).playback).toMatchObject({
      totalMs: 20000,
      remainingMs: 20000,
      running: false,
    });
  });
});

describe("authenticated computer observations", () => {
  it("remembers IDs without live messages, deduplicates and bounds retained history", () => {
    const s = state(),
      revision = s.configRevision;
    for (let i = 0; i < 34; i++)
      model.heartbeat(
        s,
        "a",
        {
          epoch: "epoch",
          instanceId: `computer-${i}`,
          itemIds: [],
          validUntil: now + 10000,
        },
        now,
      );
    expect(s.services.a.computerIds).toHaveLength(32);
    expect(s.services.a.computerIds?.[0]).toBe("computer-2");
    model.heartbeat(
      s,
      "a",
      {
        epoch: "epoch",
        instanceId: "computer-2",
        itemIds: [],
        validUntil: now + 10000,
      },
      now,
    );
    expect(s.services.a.computerIds).toHaveLength(32);
    expect(
      model
        .snapshot(s, now)
        .services.find((v) => v.id === "a")
        ?.computerIds?.at(-1),
    ).toBe("computer-2");
    expect(s.configRevision).toBe(revision);
    expect(s.services.b.computerIds).toBeUndefined();
  });
  it("does not record IDs from expired epochs or invalid heartbeats", () => {
    const s = state();
    for (const body of [
      {
        epoch: "wrong",
        instanceId: "spoof",
        itemIds: [],
        validUntil: now + 10000,
      },
      {
        epoch: "epoch",
        instanceId: "bad id",
        itemIds: [],
        validUntil: now + 10000,
      },
      { epoch: "epoch", instanceId: "spoof", itemIds: [], validUntil: now },
    ])
      expect(() => model.heartbeat(s, "a", body, now)).toThrow();
    expect(s.services.a.computerIds).toBeUndefined();
  });
});
