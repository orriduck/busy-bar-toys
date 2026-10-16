import { describe, expect, it } from "vitest";
import * as model from "../src/model";
import * as ordering from "../src/ordering";
const now = 1_800_000_000_000;
function state() {
  const s = model.createState("device");
  for (const [id, computer, priority] of [
    ["a", "computer-a", 10],
    ["b", "computer-b", 50],
    ["c", "computer-a", 90],
    ["d", "computer-b", 20],
  ] as const) {
    model.registerService(
      s,
      { id, name: id, template: "notifier" },
      "hash",
      "epoch",
      now,
    );
    s.services[id].computerId = computer;
    s.services[id].config.priority = priority;
  }
  ordering.migrateServiceOrders(s, now);
  return s;
}
function send(
  s: model.State,
  service: string,
  id = service,
  extra: Record<string, unknown> = {},
  at = now,
) {
  return model.publish(
    s,
    service,
    {
      instanceId: "mac",
      epoch: "epoch",
      itemId: id,
      version: 1,
      kind: "event",
      level: "info",
      title: id,
      firstRecognizedAt: at,
      validUntil: now + 100000,
      scene: {
        entryDurationMs: 0,
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
const selected = (s: model.State) =>
  s.selected ? s.items[s.selected].serviceId : null;
describe("explicit per-computer service order", () => {
  it("migrates legacy numeric values once and exposes no credential hashes", () => {
    const s = state();
    expect(s.computers["computer-a"].serviceOrder).toEqual(["c", "a"]);
    expect(s.computers["computer-b"].serviceOrder).toEqual(["b", "d"]);
    s.services.a.config.priority = 1000;
    expect(ordering.migrateServiceOrders(s, now)).toBe(false);
    expect(s.computers["computer-a"].serviceOrder).toEqual(["c", "a"]);
    const view = model.snapshot(s, now);
    expect(
      view.computers.find((c) => c.id === "computer-a")?.serviceOrder,
    ).toEqual(["c", "a"]);
    expect(JSON.stringify(view)).not.toContain("credentialHash");
  });
  it("uses explicit own order and ignores changed legacy priorities", () => {
    const s = state();
    send(s, "a");
    send(s, "c");
    expect(selected(s)).toBe("c");
    s.services.a.config.priority = 1000;
    model.tick(s, now + 1);
    expect(selected(s)).toBe("c");
    s.computers["computer-a"].serviceOrder = ["a", "c"];
    model.tick(s, now + 2);
    expect(selected(s)).toBe("a");
  });
  it("keeps an active computer's source lease and rotates to the next ready computer at completion", () => {
    const s = state();
    send(s, "c", "active", { kind: "agent", exit: "source" });
    model.acceptDisplay(s, s.generation, now);
    send(s, "a");
    send(s, "b");
    send(s, "d");
    expect(selected(s)).toBe("c");
    expect(model.groups(s).map((g) => g.representative.serviceId)).toEqual([
      "c",
      "b",
      "a",
      "d",
    ]);
    model.finishItem(s, s.selected!, "resolved", 1, now + 1);
    expect(selected(s)).toBe("b");
    model.acceptDisplay(s, s.generation, now + 1);
    model.finishItem(s, s.selected!, "resolved", 1, now + 2);
    expect(selected(s)).toBe("a");
  });
  it("resumes an unfinished normal source after urgent interruption and its own higher service overlay", () => {
    const s = state();
    s.computers["computer-a"].serviceOrder = ["a", "c"];
    const original = send(s, "c", "source", { kind: "agent", exit: "source" });
    model.acceptDisplay(s, s.generation, now);
    send(s, "b");
    send(s, "d", "urgent", { level: "urgent" });
    expect(selected(s)).toBe("d");
    model.acceptDisplay(s, s.generation, now);
    model.finishItem(s, s.selected!, "resolved", 1, now + 1);
    expect(s.selected).toBe(original.itemKey);
    send(s, "a", "overlay");
    model.acceptDisplay(s, s.generation, now + 2);
    expect(selected(s)).toBe("a");
    expect(model.groups(s).map((g) => g.representative.serviceId)).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(
      model.snapshot(s, now + 2).items.find((i) => i.serviceId === "b")?.eta
        .kind,
    ).toBe("await-resolution");
    model.finishItem(s, s.selected!, "resolved", 1, now + 3);
    expect(s.selected).toBe(original.itemKey);
    model.finishItem(s, s.selected!, "resolved", 1, now + 4);
    expect(selected(s)).toBe("b");
  });
  it("preserves urgent precedence and current urgent ownership across computers", () => {
    const s = state();
    send(s, "a");
    send(s, "b", "urgent", { level: "urgent" });
    expect(selected(s)).toBe("b");
    const key = s.selected!;
    send(
      s,
      "c",
      "urgent-two",
      { level: "urgent", firstRecognizedAt: now - 1000 },
      now + 1,
    );
    expect(s.selected).toBe(key);
    model.finishItem(s, key, "resolved", 1, now + 2);
    expect(selected(s)).toBe("c");
  });
  it("rejects editing obsolete service priority", () => {
    const s = state(),
      before = structuredClone(s);
    expect(() =>
      model.patchConfig(s, "a", { priority: 1000 }, s.configRevision, now),
    ).toThrow("INVALID_REQUEST");
    expect(s).toEqual(before);
  });
});
