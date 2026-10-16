import { expect, it } from "vitest";
import {
  deviceGroups,
  priorityOrder,
  serviceLabel,
} from "../ui/service-layout";
import type { Service } from "../ui/api";
const service = (id: string, name: string, priority = 10) =>
  ({ id, name, config: { priority } }) as Service;
it("groups only explicit registered device labels and preserves ungrouped services", () => {
  const values = [
    service("a", "This Mac · Codex"),
    service("b", "This Mac · ADSBao"),
    service("c", "MacBook · Notifier"),
    service("d", "Custom"),
  ];
  expect(deviceGroups(values).map((g) => [g.name, g.services.length])).toEqual([
    ["This Mac", 2],
    ["MacBook", 1],
    ["Ungrouped", 1],
  ]);
  expect(serviceLabel(values[0])).toBe("Codex");
  expect(serviceLabel(values[3])).toBe("Custom");
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
