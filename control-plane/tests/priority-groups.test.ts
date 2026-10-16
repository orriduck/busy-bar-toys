import { describe, expect, it } from "vitest";
import * as m from "../src/model";
import * as computers from "../src/computers";
import * as priorities from "../src/priority-groups";
const now = 1_800_000_000_000;
function state() {
  const s = m.createState("d");
  for (const [id, pc] of [
    ["a", "A"],
    ["a2", "A"],
    ["b", "B"],
    ["b2", "B"],
  ]) {
    s.computers[pc] ??= {
      id: pc,
      credentialHash: "hash",
      createdAt: now,
      serviceOrder: [],
    };
    m.registerService(
      s,
      { id, name: id, template: "custom", computerId: pc },
      "hash",
      "epoch",
      now,
    );
    s.services[id].config.visibleMs = 5000;
  }
  return s;
}
function send(
  s: m.State,
  serviceId: string,
  extra: Record<string, unknown> = {},
  at = now,
) {
  return m.publish(
    s,
    serviceId,
    {
      epoch: "epoch",
      instanceId: "mac",
      itemId: serviceId,
      version: 1,
      kind: "event",
      level: "info",
      title: serviceId,
      validUntil: now + 200000,
      scene: {
        entryDurationMs: 0,
        commands: [
          {
            offsetMs: 0,
            elements: [
              { id: "t", type: "text", text: serviceId, font: "small" },
            ],
          },
        ],
      },
      ...extra,
    },
    at,
  );
}
const active = (s: m.State) =>
  s.selected ? s.items[s.selected]?.serviceId : null;
describe("priority group protocol", () => {
  it("defaults registration groups and validates explicit choices before mutation", () => {
    const s = state();
    expect(m.snapshot(s, now).services[0].priorityGroup).toBe("follow-queue");
    m.registerService(
      s,
      { id: "agent", name: "Agent", template: "agent" },
      "hash",
      "epoch",
      now,
    );
    expect(s.services.agent.priorityGroup).toBe("dispensable");
    const before = structuredClone(s);
    expect(() =>
      m.registerService(
        s,
        { id: "bad", name: "Bad", template: "agent", priorityGroup: "urgent" },
        "hash",
        "epoch",
        now,
      ),
    ).toThrow("INVALID_PRIORITY_GROUP");
    expect(s).toEqual(before);
  });
  it("atomically moves a complete owned service set while preserving legacy reorder groups", () => {
    const s = state();
    computers.reorderOwnedGroups(
      s,
      "A",
      { interception: ["a2"], "follow-queue": [], dispensable: ["a"] },
      s.configRevision,
    );
    expect(s.services.a2.priorityGroup).toBe("interception");
    expect(s.computers.A.serviceOrder).toEqual(["a2", "a"]);
    computers.reorderOwnedServices(s, "A", ["a", "a2"], s.configRevision);
    expect(s.services.a2.priorityGroup).toBe("interception");
    for (const invalid of [
      { interception: ["a"], "follow-queue": ["b"], dispensable: [] },
      { interception: ["a"], "follow-queue": ["a"], dispensable: [] },
      { interception: ["a", "a2"], "follow-queue": [] },
      {
        interception: ["a", "a2"],
        "follow-queue": [],
        dispensable: [],
        extra: [],
      },
    ]) {
      const before = structuredClone(s);
      expect(() =>
        computers.reorderOwnedGroups(s, "A", invalid, s.configRevision),
      ).toThrow("INVALID_SERVICE_ORDER");
      expect(s).toEqual(before);
    }
  });
  it("migrates only missing fields without changing occurrence, credential or later edits", () => {
    const s = state();
    delete s.services.a.priorityGroup;
    s.services.a.template = "agent";
    const before = structuredClone(s.services.a);
    expect(priorities.migratePriorityGroups(s)).toBe(true);
    expect(s.services.a).toEqual({ ...before, priorityGroup: "follow-queue" });
    s.services.a.priorityGroup = "interception";
    expect(priorities.migratePriorityGroups(s)).toBe(false);
    expect(s.services.a.priorityGroup).toBe("interception");
  });
});
describe("global priority group scheduling", () => {
  it("group outranks urgency and resumes a partially consumed finite message", () => {
    const s = state();
    s.services.a.priorityGroup = "dispensable";
    s.services.b.priorityGroup = "interception";
    const a = send(s, "a", { level: "urgent", exit: "finite" });
    m.acceptDisplay(s, s.generation, now);
    send(s, "b", {}, now + 2000);
    expect(active(s)).toBe("b");
    expect(s.items[a.itemKey].remainingMs).toBe(3000);
    m.finishItem(s, s.selected!, "resolved", 1, now + 3000);
    expect(s.selected).toBe(a.itemKey);
  });
  it.each(["interception", "follow-queue"] as const)(
    "%s keeps its source until completion despite same-group urgent arrivals",
    (group) => {
      const s = state();
      s.services.a.priorityGroup = s.services.b.priorityGroup = group;
      send(s, "a", { kind: "agent", exit: "source" });
      m.acceptDisplay(s, s.generation, now);
      const b = send(s, "b", { level: "urgent" });
      m.tick(s, now + 8000);
      expect(active(s)).toBe("a");
      expect(
        m.snapshot(s, now + 8000).items.find((i) => i.itemKey === b.itemKey)
          ?.queueProof,
      ).toBeDefined();
      expect(
        m.snapshot(s, now + 8000).items.find((i) => i.itemKey === b.itemKey)
          ?.eta.kind,
      ).toBe("await-resolution");
      m.finishItem(s, s.selected!, "resolved", 1, now + 8000);
      expect(active(s)).toBe("b");
    },
  );
  it("Follow queue alternates computers at completion and uses each computer service order", () => {
    const s = state();
    send(s, "a");
    m.acceptDisplay(s, s.generation, now);
    send(s, "a2");
    send(s, "b2");
    send(s, "b");
    m.tick(s, now + 5000);
    expect(active(s)).toBe("b");
    m.acceptDisplay(s, s.generation, now + 5000);
    m.tick(s, now + 10000);
    expect(active(s)).toBe("a2");
  });
  it("Dispensable alternates computers by confirmed Hold while keeping own live head first", () => {
    const s = state();
    for (const service of Object.values(s.services))
      service.priorityGroup = "dispensable";
    send(s, "a", { kind: "agent", exit: "source" });
    m.acceptDisplay(s, s.generation, now);
    send(s, "a2", { level: "urgent" });
    send(s, "b", { kind: "agent", exit: "source" });
    m.tick(s, now + 5000);
    expect(active(s)).toBe("b");
    m.acceptDisplay(s, s.generation, now + 5000);
    m.tick(s, now + 10000);
    expect(active(s)).toBe("a");
    expect(Object.keys(s.items)).toHaveLength(3);
  });
});

it("resumes the leased Follow queue occurrence after higher-group interruption and JSON restart", () => {
  let s = state();
  s.services.b.priorityGroup = "interception";
  const a = send(s, "a", { kind: "agent", exit: "source" });
  m.acceptDisplay(s, s.generation, now);
  send(s, "a2");
  send(s, "b", {}, now + 2000);
  m.acceptDisplay(s, s.generation, now + 2000);
  s = JSON.parse(JSON.stringify(s));
  m.finishItem(s, s.selected!, "resolved", 1, now + 3000);
  expect(s.selected).toBe(a.itemKey);
  expect(s.priorityLeases["follow-queue"]).toBe(a.itemKey);
  m.tick(s, now + 9000);
  expect(s.selected).toBe(a.itemKey);
});

it("never grants urgent queue proof to paused work or past the shorter health proof", () => {
  const s = state();
  send(s, "a", { kind: "agent", exit: "source" });
  m.acceptDisplay(s, s.generation, now);
  const b = send(s, "b", { level: "urgent" });
  s.health.confirmedValidUntil = now + 1000;
  expect(
    m.snapshot(s, now).items.find((i) => i.itemKey === b.itemKey)?.queueProof
      ?.validUntil,
  ).toBe(now + 1000);
  expect(
    m.snapshot(s, now + 1001).items.find((i) => i.itemKey === b.itemKey)
      ?.queueProof,
  ).toBeUndefined();
  s.items[b.itemKey].state = "paused";
  expect(
    m.snapshot(s, now).items.find((i) => i.itemKey === b.itemKey)?.queueProof,
  ).toBeUndefined();
});

it("bounds admitted-version coverage by the shorter health proof", () => {
  const s = state();
  const a = send(s, "a", { level: "urgent" });
  m.acceptDisplay(s, s.generation, now);
  s.health.confirmedValidUntil = now + 1000;
  expect(
    m.snapshot(s, now).items.find((i) => i.itemKey === a.itemKey)?.coverageProof
      ?.validUntil,
  ).toBe(now + 1000);
  expect(
    m.snapshot(s, now + 1001).items.find((i) => i.itemKey === a.itemKey)
      ?.coverageProof,
  ).toBeUndefined();
});
