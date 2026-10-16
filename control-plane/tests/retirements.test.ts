import { expect, it } from "vitest";
import {
  createState,
  publish,
  registerService,
  type Action,
} from "../src/model";
import { migrateServiceOrders } from "../src/ordering";
import { retireApprovedLegacyRegistrations } from "../src/retirements";
const computer = "a41eb50e-7dda-427a-8ed2-d72e0e14104a";
const targets = ["macbook-agent", "macbook-notifier"];
const now = 1800000000000;
function fixture() {
  const s = createState("bar");
  for (const id of [...targets, "current-agent"]) {
    registerService(
      s,
      { id, name: id, template: "agent" },
      "hash",
      "epoch",
      now,
    );
    s.services[id].computerId = targets.includes(id) ? computer : "current-mac";
  }
  migrateServiceOrders(s, now);
  s.computers["current-mac"].credentialHash = "current-secret-hash";
  return s;
}
it("retires only the user-approved unused legacy pair, preserving playback and receipts", () => {
  const s = fixture(),
    before = structuredClone(s);
  expect(retireApprovedLegacyRegistrations(s)).toBe(true);
  const expected = structuredClone(before);
  for (const id of targets) delete expected.services[id];
  delete expected.computers[computer];
  expected.configRevision++;
  expected.revision++;
  expect(s).toEqual(expected);
  expect(retireApprovedLegacyRegistrations(s)).toBe(false);
  expect(s).toEqual(expected);
});
it("never retires an enrolled or differently owned registration", () => {
  for (const mutate of [
    (s: ReturnType<typeof fixture>) => {
      s.computers[computer].credentialHash = "claimed";
    },
    (s: ReturnType<typeof fixture>) => {
      s.services[targets[0]].lastHeartbeatAt = now;
    },
    (s: ReturnType<typeof fixture>) => {
      s.services[targets[0]].computerId = "current-mac";
    },
    (s: ReturnType<typeof fixture>) => {
      s.services["current-agent"].computerId = computer;
    },
  ]) {
    const s = fixture();
    mutate(s);
    const before = structuredClone(s);
    expect(retireApprovedLegacyRegistrations(s)).toBe(false);
    expect(s).toEqual(before);
  }
});
it("leaves the entire pair intact while any target has a live occurrence", () => {
  const s = fixture();
  publish(
    s,
    targets[0],
    {
      epoch: "epoch",
      instanceId: "old",
      itemId: "live",
      version: 1,
      kind: "agent",
      level: "info",
      title: "Live",
      validUntil: now + 60000,
      scene: {
        entryDurationMs: 0,
        commands: [
          {
            offsetMs: 0,
            elements: [{ id: "t", type: "text", font: "small", text: "Live" }],
          },
        ],
      },
    },
    now,
  );
  const before = structuredClone(s);
  expect(retireApprovedLegacyRegistrations(s)).toBe(false);
  expect(s).toEqual(before);
});
for (const status of ["pending", "running", "unknown"] as const)
  it(`preserves ${status} actions and both registrations`, () => {
    const s = fixture();
    s.actions.a = {
      id: "a",
      requestId: "r",
      itemKey: "old",
      serviceId: targets[1],
      instanceId: "old",
      itemId: "old",
      version: 1,
      generation: 1,
      actionKey: "approve",
      status,
      createdAt: now,
      expiresAt: now + 60000,
    } satisfies Action;
    const before = structuredClone(s);
    expect(retireApprovedLegacyRegistrations(s)).toBe(false);
    expect(s).toEqual(before);
  });
it("preserves completed action receipts and existing tombstones", () => {
  const s = fixture();
  s.actions.a = {
    id: "a",
    requestId: "r",
    itemKey: "old",
    serviceId: targets[1],
    instanceId: "old",
    itemId: "old",
    version: 1,
    generation: 1,
    actionKey: "approve",
    status: "succeeded",
    createdAt: now,
    expiresAt: now + 60000,
  };
  s.tombstones.old = {
    itemKey: "old",
    serviceId: targets[0],
    version: 3,
    epoch: "epoch",
    reason: "withdrawn",
    expiresAt: now + 60000,
  };
  const before = structuredClone(s);
  expect(retireApprovedLegacyRegistrations(s)).toBe(true);
  expect(s.actions).toEqual(before.actions);
  expect(s.tombstones).toEqual(before.tombstones);
});
