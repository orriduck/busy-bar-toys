import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { StateStore } from "../src/store";
import {
  createState,
  registerService,
  publish,
  acceptDisplay,
} from "../src/model";
import { migrateServiceOrders } from "../src/ordering";
import { activeComputer, claimLegacy } from "../src/computers";
it("backfills an already-playing legacy source lease and claims its migrated order without widening authority", async () => {
  const stub = env.DEVICES.getByName(crypto.randomUUID());
  await runInDurableObject(stub, (_instance, ctx) => {
    const now = Date.now(),
      s = createState("device");
    registerService(
      s,
      { id: "source", name: "Source", template: "agent" },
      "hash",
      "epoch",
      now,
    );
    s.services.source.computerId = "legacy-mac";
    publish(
      s,
      "source",
      {
        instanceId: "mac",
        epoch: "epoch",
        itemId: "one",
        version: 1,
        kind: "agent",
        level: "info",
        title: "Agent",
        firstRecognizedAt: now,
        validUntil: now + 60000,
        scene: {
          entryDurationMs: 0,
          commands: [
            {
              offsetMs: 0,
              elements: [
                { id: "t", type: "text", text: "Agent", font: "small" },
              ],
            },
          ],
        },
      },
      now,
    );
    acceptDisplay(s, s.generation, now);
    const store = new StateStore(ctx.storage);
    store.save(s);
    const row = ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM control WHERE id=1")
      .one();
    const legacy = JSON.parse(row.value);
    delete legacy.normalLeaseItem;
    delete legacy.lastNormalComputer;
    delete legacy.serviceTurns;
    delete legacy.turnSeq;
    ctx.storage.sql.exec(
      "UPDATE control SET value=? WHERE id=1",
      JSON.stringify(legacy),
    );
    const restored = store.load()!;
    expect(restored.serviceTurns).toEqual({});
    expect(restored.turnSeq).toBe(0);
    expect(restored.normalLeaseItem).toBe(s.selected);
    expect(restored.lastNormalComputer).toBe("legacy-mac");
    migrateServiceOrders(restored, now);
    expect(() => activeComputer(restored, "legacy-mac")).toThrow(
      "COMPUTER_NOT_FOUND",
    );
    expect(
      claimLegacy(restored, "source", { source: "hash" }, "new-hash", now)
        .serviceOrder,
    ).toEqual(["source"]);
    expect(activeComputer(restored, "legacy-mac").credentialHash).toBe(
      "new-hash",
    );
  });
});

it("recovers a migrated active group lease and preserves user group edits across SQLite restarts", async () => {
  const stub = env.DEVICES.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (_instance, ctx) => {
    const { migratePriorityGroups } = await import("../src/priority-groups");
    const s = createState("device"),
      now = Date.now();
    registerService(
      s,
      { id: "source", name: "Source", template: "agent" },
      "unchanged-hash",
      "unchanged-epoch",
      now,
    );
    const service = s.services.source;
    delete service.priorityGroup;
    publish(
      s,
      "source",
      {
        epoch: service.epoch,
        instanceId: "mac",
        itemId: "one",
        version: 1,
        kind: "agent",
        level: "info",
        title: "Source",
        validUntil: now + 60000,
        scene: {
          entryDurationMs: 0,
          commands: [
            {
              offsetMs: 0,
              elements: [
                { id: "t", type: "text", text: "Source", font: "small" },
              ],
            },
          ],
        },
      },
      now,
    );
    acceptDisplay(s, s.generation, now);
    const store = new StateStore(ctx.storage);
    store.save(s);
    const row = ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM control WHERE id=1")
      .one();
    const legacy = JSON.parse(row.value);
    delete legacy.priorityLeases;
    delete legacy.priorityComputerTurns;
    ctx.storage.sql.exec(
      "UPDATE control SET value=? WHERE id=1",
      JSON.stringify(legacy),
    );
    const restored = new StateStore(ctx.storage).load()!;
    expect(restored.priorityLeases["dispensable"]).toBe(s.selected);
    const beforeService = structuredClone(restored.services.source),
      beforeItems = structuredClone(restored.items);
    expect(migratePriorityGroups(restored)).toBe(true);
    expect(restored.services.source).toEqual({
      ...beforeService,
      priorityGroup: "follow-queue",
    });
    expect(restored.items).toEqual(beforeItems);
    restored.services.source.priorityGroup = "interception";
    new StateStore(ctx.storage).save(restored);
    const restarted = new StateStore(ctx.storage).load()!;
    expect(migratePriorityGroups(restarted)).toBe(false);
    expect(restarted.services.source.priorityGroup).toBe("interception");
    expect(restarted.services.source.credentialHash).toBe("unchanged-hash");
    expect(restarted.services.source.epoch).toBe("unchanged-epoch");
    expect(restarted.items).toEqual(beforeItems);
  });
});

it("constructor persists only missing-group migration and never resets later choices or live occurrence budgets", async () => {
  const stub = env.DEVICES.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (_instance, ctx) => {
    const { DeviceControl } = await import("../src/index");
    const { tick } = await import("../src/model");
    const s = createState("device"),
      now = Date.now();
    const ids = [
      "17e03307-7374-4021-a7ae-58c165ba8d6e",
      "565505c4-4c29-4d24-82e0-f97d1659156c",
      "bf0706b2-6ffc-4996-9454-61740d92c7b8",
      ...Array.from({ length: 8 }, (_, i) => "other-" + i),
    ];
    for (const [index, id] of ids.entries()) {
      registerService(
        s,
        { id, name: id, template: "agent" },
        "credential-" + id,
        "epoch-" + id,
        now,
      );
      const pc =
        index === 2
          ? "2199977f-a93e-40b1-9c25-3ebc95fa524d"
          : "c2903b6c-d5d7-4471-b388-469223a77a78";
      s.services[id].computerId = pc;
      s.computers[pc] ??= {
        id: pc,
        credentialHash: "management-" + pc,
        createdAt: now,
        serviceOrder: [],
      };
      s.computers[pc].serviceOrder.push(id);
      delete s.services[id].priorityGroup;
    }
    const source = ids[3];
    publish(
      s,
      source,
      {
        epoch: s.services[source].epoch,
        instanceId: "mac",
        itemId: "one",
        version: 1,
        kind: "event",
        level: "info",
        title: "Finite",
        validUntil: now + 60000,
        scene: {
          entryDurationMs: 0,
          commands: [
            {
              offsetMs: 0,
              elements: [
                { id: "t", type: "text", text: "Finite", font: "small" },
              ],
            },
          ],
        },
      },
      now,
    );
    acceptDisplay(s, s.generation, now);
    tick(s, now + 2000);
    s.commands = [];
    const items = structuredClone(s.items),
      orders = structuredClone(s.computers),
      services = structuredClone(s.services);
    new StateStore(ctx.storage).save(s);
    new DeviceControl(ctx, env);
    const first = new StateStore(ctx.storage).load()!;
    expect(
      Object.values(first.services).map((service) => service.priorityGroup),
    ).toEqual([
      "interception",
      "dispensable",
      "dispensable",
      ...Array(8).fill("follow-queue"),
    ]);
    expect(first.items).toEqual(items);
    expect(first.computers).toEqual(orders);
    for (const id of ids) {
      const { priorityGroup, ...service } = first.services[id];
      expect(service).toEqual(services[id]);
    }
    first.services[source].priorityGroup = "interception";
    new StateStore(ctx.storage).save(first);
    new DeviceControl(ctx, env);
    const second = new StateStore(ctx.storage).load()!;
    expect(second.services[source].priorityGroup).toBe("interception");
    expect(second.items).toEqual(items);
  });
});

it("SQLite recovery resumes the exact interrupted Follow queue lease with its remaining budget and fair computer tickets", async () => {
  const stub = env.DEVICES.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (_instance, ctx) => {
    const m = await import("../src/model"),
      { DeviceControl } = await import("../src/index");
    const s = createState("device"),
      now = Date.now();
    for (const [id, group] of [
      ["low", "follow-queue"],
      ["peer", "follow-queue"],
      ["high", "interception"],
    ])
      registerService(
        s,
        { id, name: id, template: "custom", priorityGroup: group },
        "hash-" + id,
        "epoch-" + id,
        now,
      );
    const send = (id: string, at: number) =>
      publish(
        s,
        id,
        {
          epoch: "epoch-" + id,
          instanceId: "mac",
          itemId: "one",
          version: 1,
          kind: "event",
          level: "info",
          title: id,
          validUntil: now + 60000,
          scene: {
            entryDurationMs: 0,
            commands: [
              {
                offsetMs: 0,
                elements: [{ id: "t", type: "text", text: id, font: "small" }],
              },
            ],
          },
        },
        at,
      );
    const low = send("low", now);
    acceptDisplay(s, s.generation, now);
    send("peer", now);
    send("high", now + 2000);
    acceptDisplay(s, s.generation, now + 2000);
    s.commands = [];
    const tickets = structuredClone(s.priorityComputerTurns),
      leases = structuredClone(s.priorityLeases);
    new StateStore(ctx.storage).save(s);
    new DeviceControl(ctx, env);
    const restored = new StateStore(ctx.storage).load()!;
    expect(restored.priorityComputerTurns).toEqual(tickets);
    expect(restored.priorityLeases).toEqual(leases);
    expect(restored.items[low.itemKey].remainingMs).toBe(8000);
    m.finishItem(restored, restored.selected!, "resolved", 1, now + 3000);
    expect(restored.selected).toBe(low.itemKey);
    acceptDisplay(restored, restored.generation, now + 3000);
    m.tick(restored, now + 11000);
    expect(restored.items[restored.selected!].serviceId).toBe("peer");
  });
});
