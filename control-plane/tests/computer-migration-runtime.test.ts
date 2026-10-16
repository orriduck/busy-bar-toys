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
    ctx.storage.sql.exec(
      "UPDATE control SET value=? WHERE id=1",
      JSON.stringify(legacy),
    );
    const restored = store.load()!;
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
