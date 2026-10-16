import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { DeviceControl } from "../src/index";
import { StateStore } from "../src/store";
import { createState, registerService } from "../src/model";
import { migrateServiceOrders } from "../src/ordering";

it("persists the approved retirement at startup without scheduling display commands", async () => {
  const stub = env.DEVICES.getByName(crypto.randomUUID());
  await runInDurableObject(stub, (_instance, ctx) => {
    const s = createState("bar"),
      now = Date.now();
    for (const id of ["macbook-agent", "macbook-notifier", "keep"]) {
      registerService(
        s,
        { id, name: id, template: "agent" },
        "hash",
        "epoch",
        now,
      );
      s.services[id].computerId =
        id === "keep" ? "current-mac" : "a41eb50e-7dda-427a-8ed2-d72e0e14104a";
    }
    migrateServiceOrders(s, now);
    const store = new StateStore(ctx.storage);
    store.save(s);
    new DeviceControl(ctx, env);
    const restored = store.load()!;
    expect(Object.keys(restored.services)).toEqual(["keep"]);
    expect(restored.services.keep).toEqual(s.services.keep);
    expect(restored.commands).toEqual(s.commands);
    expect(restored.generation).toBe(s.generation);
    expect(restored.configRevision).toBe(s.configRevision + 1);
    new DeviceControl(ctx, env);
    expect(store.load()).toEqual(restored);
  });
});
