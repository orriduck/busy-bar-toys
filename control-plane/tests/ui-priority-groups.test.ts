import { describe, expect, it } from "vitest";
import {
  globalPriorityGroups,
  moveOwnedService,
  ownedPriorityGroups,
} from "../ui/priority-groups";
import type { Service, Snapshot } from "../ui/api";
const services = [
  {
    id: "a",
    computerId: "own",
    template: "notifier",
    priorityGroup: "follow-queue",
  },
  {
    id: "b",
    computerId: "own",
    template: "notifier",
    priorityGroup: "follow-queue",
  },
  {
    id: "c",
    computerId: "own",
    template: "agent",
    priorityGroup: "dispensable",
  },
  {
    id: "foreign-a",
    computerId: "peer",
    template: "notifier",
    priorityGroup: "follow-queue",
  },
  {
    id: "foreign-b",
    computerId: "peer",
    template: "notifier",
    priorityGroup: "follow-queue",
  },
] as Service[];
const snapshot = {
  services,
  items: [],
  computers: [
    { id: "own", serviceOrder: ["b", "c", "a"] },
    { id: "peer", serviceOrder: ["foreign-b", "foreign-a"] },
  ],
} as unknown as Snapshot;
describe("own priority group movement", () => {
  it("uses server order within each group and represents empty groups", () => {
    expect(ownedPriorityGroups(snapshot, "own")).toEqual({
      interception: [],
      "follow-queue": ["b", "a"],
      dispensable: ["c"],
    });
    expect(ownedPriorityGroups(snapshot, null)).toEqual({
      interception: [],
      "follow-queue": [],
      dispensable: [],
    });
  });
  it("reorders only the own queue and supports moving to an empty global group", () => {
    const base = ownedPriorityGroups(snapshot, "own");
    const reordered = moveOwnedService(base, "a", "follow-queue", "b");
    expect(reordered["follow-queue"]).toEqual(["a", "b"]);
    const next = moveOwnedService(reordered, "b", "interception");
    expect(next).toEqual({
      interception: ["b"],
      "follow-queue": ["a"],
      dispensable: ["c"],
    });
    expect(base["follow-queue"]).toEqual(["b", "a"]);
    expect(Object.values(next).flat().sort()).toEqual(["a", "b", "c"]);
  });
  it("refuses foreign sources and targets without indirectly changing queues", () => {
    const base = ownedPriorityGroups(snapshot, "own");
    expect(moveOwnedService(base, "foreign-a", "interception")).toBe(base);
    expect(moveOwnedService(base, "a", "follow-queue", "foreign-a")).toBe(base);
  });
  it("keeps every foreign group and relative order authoritative during an own draft", () => {
    const draft = moveOwnedService(
      ownedPriorityGroups(snapshot, "own"),
      "b",
      "interception",
    );
    const groups = globalPriorityGroups(snapshot, "own", draft);
    expect(groups.map((g) => g.id)).toEqual([
      "interception",
      "follow-queue",
      "dispensable",
    ]);
    expect(groups[0].services.map((s) => s.id)).toEqual(["b"]);
    expect(groups[1].services.map((s) => s.id)).toEqual([
      "a",
      "foreign-b",
      "foreign-a",
    ]);
    expect(groups[2].services.map((s) => s.id)).toEqual(["c"]);
    expect(
      services
        .filter((s) => s.computerId === "peer")
        .map((s) => [s.id, s.priorityGroup]),
    ).toEqual([
      ["foreign-a", "follow-queue"],
      ["foreign-b", "follow-queue"],
    ]);
  });
});
