import { expect, it } from "vitest";
import * as model from "../src/model";
import { migrateComputerIds } from "../src/computers";
import { resolveComputerBinding } from "../ui/service-layout";
import { queueMetadata } from "../ui/queue-metadata";
import type { Service, Snapshot, QueueItem } from "../ui/api";
const now = 1800000000000;
function legacy() {
  const s = model.createState("bar");
  for (const [id, name] of [
    ["a", "This Mac · Codex"],
    ["b", "This Mac · ADSBao"],
    ["c", "MacBook · Claude"],
    ["d", "MacBook · Notifier"],
    ["e", "Custom"],
  ]) {
    model.registerService(
      s,
      { id, name, template: "notifier" },
      "hash",
      "epoch",
      now,
    );
    delete s.services[id].computerId;
  }
  s.services.a.computerIds = ["old-local"];
  s.services.c.computerIds = ["old-agent"];
  s.services.d.computerIds = ["old-notifier"];
  return s;
}
it("issues fresh IDs per legacy declared computer, once, without rekeying display state", () => {
  const s = legacy();
  model.publish(
    s,
    "a",
    {
      epoch: "epoch",
      instanceId: "old-local",
      itemId: "live",
      version: 1,
      kind: "event",
      level: "info",
      title: "Queued",
      validUntil: now + 60000,
      scene: {
        entryDurationMs: 0,
        commands: [
          {
            offsetMs: 0,
            elements: [
              { id: "text", type: "text", font: "small", text: "queued" },
            ],
          },
        ],
      },
    },
    now,
  );
  const before = structuredClone(s);
  let serial = 0;
  expect(migrateComputerIds(s, () => `new-${++serial}`)).toBe(true);
  expect(s.services.a.computerId).toBe("new-1");
  expect(s.services.b.computerId).toBe("new-1");
  expect(s.services.c.computerId).toBe("new-2");
  expect(s.services.d.computerId).toBe("new-2");
  expect(s.services.e.computerId).toBe("new-3");
  expect(s.revision).toBe(before.revision + 1);
  expect(s.configRevision).toBe(before.configRevision + 1);
  for (const service of Object.values(s.services)) {
    const { computerId: _id, ...rest } = service;
    expect(rest).toEqual(before.services[service.id]);
  }
  const { services: _a, revision: _b, configRevision: _c, ...rest } = s;
  const {
    services: _d,
    revision: _e,
    configRevision: _f,
    ...original
  } = before;
  expect(rest).toEqual(original);
  const persisted = JSON.parse(JSON.stringify(s));
  expect(
    migrateComputerIds(persisted, () => {
      throw Error("must not regenerate");
    }),
  ).toBe(false);
  expect(persisted).toEqual(s);
});
it("preserves assigned IDs and refuses registration into a different Bar's computer", () => {
  const s = model.createState("bar");
  const a = model.registerService(
    s,
    { id: "a", name: "Codex", template: "agent" },
    "hash",
    "epoch",
    now,
  );
  expect(a.computerId).toMatch(/^[a-f0-9-]{36}$/);
  const b = model.registerService(
    s,
    {
      id: "b",
      name: "Notifier",
      template: "notifier",
      computerId: a.computerId,
    },
    "other",
    "epoch2",
    now,
  );
  expect(b.computerId).toBe(a.computerId);
  const before = structuredClone(s);
  expect(() =>
    model.registerService(
      s,
      { id: "c", name: "Bad", template: "custom", computerId: "unknown" },
      "hash",
      "epoch",
      now,
    ),
  ).toThrow("COMPUTER_NOT_FOUND");
  expect(s).toEqual(before);
  expect(migrateComputerIds(s)).toBe(false);
});
it("migrates the browser badge through known source IDs but never guesses an ambiguous computer", () => {
  const services = [
    { id: "a", computerId: "new-1", computerIds: ["old-local"] },
    { id: "b", computerId: "new-1", computerIds: ["old-local"] },
  ] as Service[];
  expect(resolveComputerBinding("old-local", services)).toBe("new-1");
  expect(resolveComputerBinding("new-1", services)).toBe("new-1");
  expect(resolveComputerBinding(null, services)).toBeNull();
  expect(
    resolveComputerBinding("old-local", [
      ...services,
      { id: "c", computerId: "new-2", computerIds: ["old-local"] } as Service,
    ]),
  ).toBe("old-local");
});
it("shows the new computer identity in senders, with source IDs retained on protocol items", () => {
  const item = {
    instanceId: "old-local",
    serviceId: "a",
    receivedAt: now,
  } as QueueItem;
  const snapshot = {
    services: [
      {
        id: "a",
        name: "This Mac · Codex",
        computerId: "new-1",
        template: "agent",
      },
    ],
  } as Snapshot;
  expect(queueMetadata(item, snapshot).sender).toBe("new-1 · Codex");
  expect(item.instanceId).toBe("old-local");
});
