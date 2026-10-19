import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { StateStore } from "../src/store";
import {
  ServiceMotionClock,
  isMotionElement,
  motionElements,
} from "../src/service-motion";
import type { Element, State } from "../src/model";
import { enrollTestBrowser } from "./helpers/computer";

const devices = new Set<string>();
let token: string;
let calls: {
  method: string;
  body?: { elements?: Element[]; element_ids?: string[] };
}[];
let native: Map<string, Element>;
let calendar: number;
let foreign: number;

beforeEach(() => {
  token = "motion-fixture-" + crypto.randomUUID();
  calls = [];
  native = new Map();
  calendar = 0;
  foreign = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.headers.get("Authorization") !== "Bearer " + token) {
      foreign++;
      throw new Error("Unexpected fixture request");
    }
    if (new URL(request.url).pathname === "/busybar/status")
      return Response.json({ device: { serial_number: crypto.randomUUID() } });
    const body = request.body
      ? ((await request.json()) as {
          elements?: Element[];
          element_ids?: string[];
        })
      : undefined;
    calls.push({ method: request.method, body });
    if (request.method === "DELETE") {
      if (body?.element_ids)
        for (const id of body.element_ids) native.delete(id);
      else native.clear();
    } else
      for (const element of body?.elements ?? [])
        native.set(element.id, element);
    if (!native.size) calendar++;
    return Response.json({ ok: true });
  });
});

afterEach(async () => {
  for (const id of devices)
    await runInDurableObject(
      env.DEVICES.getByName(id),
      async (_instance, ctx) => {
        ctx.storage.transactionSync(() => {
          for (const table of [
            "control",
            "audit",
            "state_items",
            "state_assets",
            "state_tombstones",
            "state_actions",
            "state_inputs",
            "state_commands",
          ])
            ctx.storage.sql.exec(`DELETE FROM ${table}`);
        });
        await ctx.storage.deleteAlarm();
      },
    );
  devices.clear();
  expect(foreign).toBe(0);
  vi.restoreAllMocks();
});

async function fixture() {
  const session = await exports.default.fetch(
    "https://control.test/api/session",
    {
      method: "POST",
      headers: {
        Origin: "https://control.test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
    },
  );
  const { deviceId } = (await session.json()) as { deviceId: string };
  devices.add(deviceId);
  const cookie = session.headers.get("Set-Cookie")!.split(";")[0];
  await enrollTestBrowser(deviceId, cookie);
  const admin = (path: string, body?: unknown) =>
    exports.default.fetch("https://control.test/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        cookie,
        "X-Busy-Device": deviceId,
        Origin: "https://control.test",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const registration = await admin("/services", {
    id: "test",
    name: "Test",
    template: "notifier",
    expectedRevision: 0,
  });
  const normal = (await registration.json()) as {
    credential: string;
    epoch: string;
  };
  const urgentRegistration = await admin("/services", {
    id: "urgent",
    name: "Urgent",
    template: "notifier",
    priorityGroup: "interception",
    expectedRevision: 1,
  });
  const { credential, epoch } = (await urgentRegistration.json()) as {
    credential: string;
    epoch: string;
  };
  const send = async (path: string, body: unknown, auth = credential) => {
    const response = await exports.default.fetch(
      "https://control.test/api" + path,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + auth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    await response.arrayBuffer();
    expect(response.status).toBe(200);
  };
  const clock = { now: 0 };
  const stub = env.DEVICES.getByName(deviceId);
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { motionClock: ServiceMotionClock }).motionClock =
      new ServiceMotionClock(() => clock.now);
  });
  const state = () =>
    runInDurableObject(stub, (_instance, ctx) =>
      new StateStore(ctx.storage).load()!,
    );
  const mutate = (change: (s: State) => void) =>
    runInDurableObject(stub, (_instance, ctx) => {
      const store = new StateStore(ctx.storage),
        s = store.load()!;
      change(s);
      store.save(s);
    });
  const wait = async (predicate: (s: State) => boolean) => {
    for (let n = 0; n < 80; n++) {
      await (await admin("/snapshot")).arrayBuffer();
      const current = await state();
      if (predicate(current)) return current;
    }
    throw new Error("fixture did not settle");
  };
  const advance = async (now: number) => {
    clock.now = now;
    await runInDurableObject(stub, async (instance, ctx) => {
      const store = new StateStore(ctx.storage),
        s = store.load()!;
      if (s.commands[0]) s.commands[0].dueAt = Date.now();
      store.save(s);
      await instance.alarm();
    });
    return state();
  };
  const publish = (id: string, level = "info", version = 1) =>
    send(
      "/publish",
      {
        epoch: id === "old" ? normal.epoch : epoch,
        instanceId: "mac",
        itemId: id,
        version,
        firstRecognizedAt: Date.now(),
        validUntil: Date.now() + 60_000,
        kind: "event",
        level,
        title: id,
        detail: "",
        scene: {
          entryDurationMs: 0,
          commands: [
            {
              offsetMs: 0,
              elements: [
                {
                  id: id + "-text",
                  type: "text",
                  text: id,
                  font: "small",
                  z_index: 40,
                },
              ],
            },
          ],
        },
      },
      id === "old" ? normal.credential : credential,
    );
  const end = (id: string) =>
    send(
      "/end",
      {
        epoch: id === "old" ? normal.epoch : epoch,
        instanceId: "mac",
        itemId: id,
        version: 1,
      },
      id === "old" ? normal.credential : credential,
    );
  await publish("old");
  await wait((s) => !!s.displaying);
  const coldCalendar = calendar;
  return {
    epoch,
    send,
    publish,
    end,
    wait,
    advance,
    state,
    mutate,
    setClock: (now: number) => {
      clock.now = now;
    },
    normalEpoch: normal.epoch,
    normalSend: (path: string, body: unknown) =>
      send(path, body, normal.credential),
    coldCalendar,
  };
}

describe("acknowledged service exits", () => {
  it("uses elapsed 199/200/399/400 boundaries and never exposes calendar between services", async () => {
    const f = await fixture();
    await f.publish("incoming", "urgent");
    await f.wait(
      (s) =>
        !!s.serviceMotion &&
        Object.keys(s.nativeElements).some(isMotionElement),
    );
    await f.advance(199);
    expect(
      [...native.values()]
        .filter((e) => isMotionElement(e.id))
        .every((e) => e.opacity === 99),
    ).toBe(true);
    expect((await f.state()).displaying).toBeNull();
    await f.advance(200);
    expect((await f.state()).serviceMotion?.phase).toBe("black");
    expect(
      [...native.values()]
        .filter((e) => isMotionElement(e.id))
        .every((e) => e.opacity === 100),
    ).toBe(true);
    await f.advance(399);
    expect((await f.state()).serviceMotion?.phase).toBe("black");
    await f.advance(400);
    const done = await f.wait(
      (s) => !!s.displaying && s.items[s.selected!].itemId === "incoming",
    );
    expect(done.serviceMotion).toBeUndefined();
    expect(calendar).toBe(f.coldCalendar);
    expect(native.has("old-text")).toBe(false);
    const entrance = calls.findIndex((c) =>
      c.body?.elements?.some((e) => e.id === "incoming-text"),
    );
    expect(
      calls[entrance].body?.elements?.find((e) => e.id === "old-text")?.text,
    ).toBe(" ");
    expect(
      calls[entrance].body?.elements
        ?.filter((e) => isMotionElement(e.id))
        .map((e) => e.opacity),
    ).toEqual([0, 0, 0, 0, 0]);
    expect(
      calls
        .slice(entrance + 1)
        .some((c) => c.body?.element_ids?.some(isMotionElement)),
    ).toBe(true);
  });

  it("keeps one exit through candidate churn and selected content refresh", async () => {
    const f = await fixture();
    await f.publish("first", "urgent");
    const first = await f.wait(
      (s) =>
        !!s.serviceMotion &&
        Object.keys(s.nativeElements).some(isMotionElement),
    );
    const id = first.serviceMotion!.id;
    await f.advance(150);
    await f.end("first");
    await f.publish("latest", "urgent");
    const selected = await f.state();
    await f.send("/update", {
      epoch: f.epoch,
      instanceId: "mac",
      itemId: "latest",
      version: 2,
      generation: selected.generation,
      elements: [
        {
          id: "latest-text",
          type: "text",
          text: "updated",
          font: "small",
          z_index: 40,
        },
      ],
    });
    expect((await f.state()).serviceMotion?.id).toBe(id);
    await f.advance(200);
    await f.advance(400);
    const done = await f.wait((s) => !!s.displaying && !s.commands.length);
    expect(done.items[done.selected!].itemId).toBe("latest");
    expect(native.get("latest-text")?.text).toBe("updated");
    expect(native.has("first-text")).toBe(false);
    expect(calendar).toBe(f.coldCalendar);
  });

  it("holds black before the final empty clear even though there is no selected Item", async () => {
    const f = await fixture();
    await f.end("old");
    await f.wait(
      (s) =>
        s.selected === null &&
        !!s.serviceMotion &&
        Object.keys(s.nativeElements).some(isMotionElement),
    );
    await f.advance(200);
    await f.advance(399);
    expect(native.size).toBeGreaterThan(0);
    expect(calendar).toBe(f.coldCalendar);
    await f.advance(400);
    const done = await f.wait((s) => !s.commands.length);
    expect(native.size).toBe(0);
    expect(calendar).toBe(f.coldCalendar + 1);
    expect(done.serviceMotion).toBeUndefined();
    expect(done.selected).toBeNull();
  });

  it("starts the black hold after an opaque ACK, even when that ACK is delayed", async () => {
    const f = await fixture();
    await f.publish("incoming", "urgent");
    await f.wait(
      (s) =>
        !!s.serviceMotion &&
        Object.keys(s.nativeElements).some(isMotionElement),
    );
    const upstream = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const body =
        request.method === "POST"
          ? ((await request.clone().json()) as { elements?: Element[] })
          : undefined;
      const result = await upstream(request);
      if (
        body?.elements?.length &&
        body.elements.every((e) => isMotionElement(e.id) && e.opacity === 100)
      ) {
        f.setClock(500);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return result;
    });
    await f.advance(200);
    expect((await f.state()).serviceMotion?.phase).toBe("black");
    await f.advance(699);
    expect((await f.state()).displaying).toBeNull();
    await f.advance(700);
    await f.wait((s) => !!s.displaying);
  });

  it("unmasks the incoming draw atomically before a delayed retirement DELETE", async () => {
    const f = await fixture();
    await f.publish("incoming", "urgent");
    await f.wait(
      (s) =>
        !!s.serviceMotion &&
        Object.keys(s.nativeElements).some(isMotionElement),
    );
    await f.advance(200);
    const upstream = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let visibleDuringDelete = false;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (request.method === "DELETE") {
        const body = (await request.clone().json()) as {
          element_ids?: string[];
        };
        if (body.element_ids?.some(isMotionElement)) {
          visibleDuringDelete =
            native.get("incoming-text")?.text === "incoming" &&
            native.get("old-text")?.text === " " &&
            [...native.values()]
              .filter((e) => isMotionElement(e.id))
              .every((e) => e.opacity === 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      return upstream(request);
    });
    await f.advance(400);
    expect(visibleDuringDelete).toBe(true);
    await f.wait((s) => !!s.displaying);
    expect(calendar).toBe(f.coldCalendar);
  });

  it("stages a full 32-element scene under black and starts its shared entry with the unmask", async () => {
    const f = await fixture();
    const helper: Element = {
      id: "shared-service-entry",
      type: "xpmbitmap",
      display: "front",
      x: 0,
      y: 0,
      z_index: 90,
      opacity: 100,
      data: "! XPM2\n1 1 1 1\nB c #000000\nB\n",
    };
    const crowded: Element[] = [
      ...Array.from(
        { length: 31 },
        (_, n) =>
          ({
            id: "incoming-" + n,
            type: "text",
            text: "new",
            font: "small",
            z_index: 40,
          }) as Element,
      ),
      helper,
    ];
    await f.send("/publish", {
      epoch: f.epoch,
      instanceId: "mac",
      itemId: "crowded",
      version: 1,
      firstRecognizedAt: Date.now(),
      validUntil: Date.now() + 60_000,
      kind: "event",
      level: "urgent",
      title: "Crowded",
      detail: "",
      scene: {
        entryDurationMs: 720,
        commands: [
          { offsetMs: 0, elements: crowded },
          { offsetMs: 720, elements: [{ ...helper, opacity: 0 }] },
        ],
      },
    });
    await f.wait(
      (s) =>
        !!s.serviceMotion &&
        Object.keys(s.nativeElements).some(isMotionElement),
    );
    await f.advance(200);
    await f.advance(400);
    const pending = await f.wait(
      (s) =>
        s.entryAt !== null &&
        s.commands.some((c) =>
          c.elements?.some((e) => e.id === helper.id && e.opacity === 0),
        ),
    );
    const draws = calls.flatMap((c) =>
      c.method === "POST" && c.body?.elements ? [c.body.elements] : [],
    );
    const staged = draws.findIndex(
      (elements) =>
        elements.length === 32 && elements.some((e) => e.id === helper.id),
    );
    const unmask = draws
      .slice(staged + 1)
      .find((elements) =>
        elements.some((e) => isMotionElement(e.id) && e.opacity === 0),
      );
    expect(unmask?.find((e) => e.id === helper.id)?.opacity).toBe(100);
    expect(unmask).toHaveLength(6);
    const clear = pending.commands.find((c) =>
      c.elements?.some((e) => e.id === helper.id && e.opacity === 0),
    );
    expect(clear?.dueAt).toBe(pending.entryAt);
    expect(native.get("old-text")).toBeUndefined();
    expect(calendar).toBe(f.coldCalendar);
  });

  it("does not replay or prematurely cancel the shared entry on a same-item publish", async () => {
    const f = await fixture();
    const helper: Element = {
      id: "shared-service-entry",
      type: "xpmbitmap",
      display: "front",
      z_index: 90,
      opacity: 100,
      data: "! XPM2\n1 1 1 1\nB c #000000\nB\n",
    };
    const originalDue = Date.now() + 720;
    native.set(helper.id, helper);
    await f.mutate((s) => {
      const item = s.items[s.selected!];
      item.scene = {
        entryDurationMs: 720,
        commands: [
          { offsetMs: 0, elements: [s.nativeElements["old-text"], helper] },
          { offsetMs: 720, elements: [{ ...helper, opacity: 0 }] },
        ],
      };
      s.nativeElements[helper.id] = helper;
      s.elementExpiries[helper.id] = {
        type: "xpmbitmap",
        expiresAt: Date.now() + 60_000,
      };
      s.displaying = null;
      s.visibleSince = null;
      s.applying = s.selected;
      s.entryAt = originalDue;
      s.commands.push({
        id: ++s.commandSeq,
        generation: s.generation,
        kind: "draw",
        dueAt: originalDue,
        status: "pending",
        attempts: 0,
        elements: [{ ...helper, opacity: 0 }],
      });
    });
    const newHelper = { ...helper, data: "! XPM2\n1 1 1 1\nW c #FFFFFF\nW\n" };
    await f.normalSend("/publish", {
      epoch: f.normalEpoch,
      instanceId: "mac",
      itemId: "old",
      version: 2,
      firstRecognizedAt: Date.now(),
      validUntil: Date.now() + 60_000,
      kind: "event",
      level: "info",
      title: "old",
      detail: "",
      scene: {
        entryDurationMs: 720,
        commands: [
          {
            offsetMs: 0,
            elements: [
              {
                id: "old-text",
                type: "text",
                text: "fresh",
                font: "small",
                z_index: 40,
              },
              newHelper,
            ],
          },
          { offsetMs: 720, elements: [{ ...newHelper, opacity: 0 }] },
        ],
      },
    });
    const pending = await f.state();
    const entryWrites = pending.commands.filter((c) =>
      c.elements?.some((e) => e.id === helper.id),
    );
    expect(entryWrites).toHaveLength(1);
    expect(entryWrites[0].dueAt).toBe(originalDue);
    expect(native.get(helper.id)?.opacity).toBe(100);
    expect(
      pending.items[pending.selected!].scene.commands[0].elements.find(
        (e) => e.id === helper.id,
      )?.data,
    ).toBe(newHelper.data);
    await f.mutate((s) => {
      for (const c of s.commands) c.dueAt = Date.now();
    });
    await f.advance(720);
    await f.wait((s) => !s.commands.length);
    expect(native.get(helper.id)?.opacity).toBe(0);
    expect(native.get(helper.id)?.data).toBe(helper.data);
    expect(native.get("old-text")?.text).toBe("fresh");
  });

  it("exits a visible late-ACK handoff before drawing a newer candidate", async () => {
    const f = await fixture();
    await f.publish("incoming", "urgent");
    const fading = await f.wait(
      (s) =>
        !!s.serviceMotion &&
        Object.keys(s.nativeElements).some(isMotionElement),
    );
    const oldId = fading.serviceMotion!.id;
    // Represent the acknowledged result of an older in-flight incoming draw:
    // its masks became transparent after the newer candidate was selected.
    await f.mutate((s) => {
      s.serviceMotion!.phase = "handoff";
      s.commands = s.commands.filter((c) => c.kind !== "motion");
      for (const e of motionElements(0)) {
        s.nativeElements[e.id] = e;
        s.elementExpiries[e.id] = {
          type: "xpmbitmap",
          expiresAt: Date.now() + 60_000,
        };
        native.set(e.id, e);
      }
    });
    await f.advance(0);
    expect((await f.state()).serviceMotion?.id).not.toBe(oldId);
    expect((await f.state()).serviceMotion?.phase).toBe("fade");
    expect(native.get("incoming-text")).toBeUndefined();
    await f.advance(199);
    expect(native.get("control-service-motion-front")?.opacity).toBe(99);
    await f.advance(200);
    await f.advance(400);
    await f.wait(
      (s) => !!s.displaying && s.items[s.selected!].itemId === "incoming",
    );
    expect(calendar).toBe(f.coldCalendar);
  });
});
