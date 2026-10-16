import { expect, it } from "vitest";
import {
  deviceGroups,
  priorityOrder,
  serviceLabel,
} from "../ui/service-layout";
import type { Service } from "../ui/api";
const service = (id: string, name: string, priority = 10) =>
  ({ id, name, config: { priority } }) as Service;
it("groups by observed computer IDs and never treats This Mac as identity", () => {
  const a = {
    ...service("a", "This Mac · Codex"),
    computerIds: ["computer-a"],
  };
  const b = {
    ...service("b", "This Mac · ADSBao"),
    computerIds: ["computer-b"],
  };
  const c = {
    ...service("c", "Old name · Notifier"),
    computerIds: ["computer-a"],
  };
  expect(
    deviceGroups([a, b, c, service("d", "Custom")]).map((g) => [
      g.name,
      g.services.length,
    ]),
  ).toEqual([
    ["computer-a", 2],
    ["computer-b", 1],
    ["service:d", 1],
  ]);
  expect(serviceLabel(a)).toBe("Codex");
});
it("falls back to live item IDs and supports shared services on multiple computers", () => {
  const a = service("a", "Some label");
  const items = [
    { serviceId: "a", instanceId: "computer-a" },
    { serviceId: "a", instanceId: "computer-b" },
  ] as import("../ui/api").QueueItem[];
  expect(deviceGroups([a], items).map((g) => g.name)).toEqual([
    "computer-a",
    "computer-b",
  ]);
});
it("sorts descending priority with stable deterministic ties without mutating the source", () => {
  const values = [
    service("b", "B", 50),
    service("a", "A", 50),
    service("c", "C", 100),
  ];
  expect(priorityOrder(values).map((v) => v.id)).toEqual(["c", "a", "b"]);
  expect(values.map((v) => v.id)).toEqual(["b", "a", "c"]);
});

it("uses managed IDs even if legacy publishers use different role IDs", () => {
  const services = [
    {
      ...service("a", "MacBook · Claude"),
      computerId: "new-mac",
      computerIds: ["old-agent"],
    },
    {
      ...service("b", "MacBook · Notifier"),
      computerId: "new-mac",
      computerIds: ["old-notifier"],
    },
  ];
  expect(
    deviceGroups(services).map((g) => [g.name, g.services.length]),
  ).toEqual([["new-mac", 2]]);
});
