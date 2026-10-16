import { expect, it } from "vitest";
import {
  deviceGroups,
  orderedDeviceGroups,
  serviceLabel,
} from "../ui/service-layout";
import type { Service } from "../ui/api";
const service = (id: string, name: string) => ({ id, name }) as Service;
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
it("shows all computers in server order without mutating services", () => {
  const values = [
    { ...service("b", "B"), computerId: "own" },
    { ...service("a", "A"), computerId: "own" },
    { ...service("c", "C"), computerId: "peer" },
  ];
  const groups = orderedDeviceGroups({
    services: values,
    items: [],
    computers: [
      { id: "own", serviceOrder: ["a", "b"], enrolled: true },
      { id: "peer", serviceOrder: ["c"], enrolled: false },
    ],
  });
  expect(groups.map((g) => [g.name, g.services.map((s) => s.id)])).toEqual([
    ["own", ["a", "b"]],
    ["peer", ["c"]],
  ]);
  expect(values.map((s) => s.id)).toEqual(["b", "a", "c"]);
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
