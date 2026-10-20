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
import {
  preparedBlackAssets,
  nativeBlackHoldAsset,
  PREPARED_ENTRY_PREFIX,
} from "../src/prepared-handoff";
import { digest, base64 } from "../src/security";

const devices = new Set<string>();
let token: string;
let calls: {
  method: string;
  path: string;
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
    const path = new URL(request.url).pathname;
    const body =
      request.body && path.endsWith("/display/draw")
        ? ((await request.json()) as {
            elements?: Element[];
            element_ids?: string[];
          })
        : undefined;
    calls.push({ method: request.method, path, body });
    if (!path.endsWith("/display/draw")) return Response.json({ ok: true });
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
    // Boundary tests advance their clock explicitly; a timer wake alone must
    // never advance this clock or complete a phase.
    (
      instance as unknown as { motionFenceWait: () => Promise<void> }
    ).motionFenceWait = async () => {};
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
  const observe = async (predicate: (s: State) => boolean) => {
    // Read SQL only: neither an alarm nor a management fetch can restart dispatch.
    for (let n = 0; n < 80; n++) {
      const current = await state();
      if (predicate(current)) return current;
    }
    throw new Error("inline dispatch did not settle");
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
  // Historical filenames can be reused without creating alternate extensions.
  await mutate((s) => {
    s.slots = [0, 1].map((slot) => ({
      slot,
      hash: String(slot).padStart(64, "a"),
      type: "anim",
      bytes: 1,
      uploaded: true,
    }));
  });
  const coldCalendar = calendar;
  return {
    epoch,
    send,
    publish,
    end,
    wait,
    observe,
    advance,
    alarm: () =>
      runInDurableObject(stub, async (instance) => {
        await instance.alarm();
      }),
    state,
    mutate,
    inlineWait: async (change?: (state: State) => void) => {
      const waits: number[] = [];
      await runInDurableObject(stub, (instance, ctx) => {
        (
          instance as unknown as {
            motionFenceWait: (milliseconds: number) => Promise<void>;
          }
        ).motionFenceWait = async (milliseconds) => {
          waits.push(milliseconds);
          clock.now += milliseconds;
          if (change) {
            const store = new StateStore(ctx.storage),
              state = store.load()!;
            change(state);
            store.save(state);
          }
        };
      });
      return waits;
    },
    diagnostics: async () =>
      (await admin("/diagnostics/display")).json() as Promise<{
        events: { kind: string; data: Record<string, unknown> }[];
      }>,
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
  it("finishes both local fences and sends incoming content without another alarm", async () => {
    const f = await fixture(),
      waits = await f.inlineWait();
    await f.publish("incoming", "urgent");
    const done = await f.observe(
      (s) => !!s.displaying && s.items[s.selected!].itemId === "incoming",
    );
    expect(waits).toEqual([200, 200]);
    expect(done.serviceMotion).toBeUndefined();
    expect(native.has("incoming-text")).toBe(true);
    expect(calendar).toBe(f.coldCalendar);
  });

  it("does not send the old incoming scene when a candidate changes during an inline fence", async () => {
    const f = await fixture();
    const waits = await f.inlineWait((state) => {
      // Simulate a concurrent fetch cancelling the selection while dispatch sleeps.
      state.generation++;
      state.selected = null;
      state.applying = null;
      state.items = {};
      state.commands = [];
      delete state.serviceMotion;
    });
    await f.publish("incoming", "urgent");
    await f.observe((s) => s.selected === null && s.commands.length === 0);
    expect(waits).toEqual([200]);
    expect(native.has("incoming-text")).toBe(false);
    expect(
      calls.some((c) =>
        c.body?.elements?.some((e) => e.id === "incoming-text"),
      ),
    ).toBe(false);
  });

  it("uses elapsed 199/200/399/400 boundaries and never exposes calendar between services", async () => {
    const f = await fixture();
    await f.publish("incoming", "urgent");
    await f.wait(
      (s) =>
        !!s.serviceMotion &&
        Object.keys(s.nativeElements).some(isMotionElement),
    );
    await f.advance(199);
    expect((await f.state()).serviceMotion?.phase).toBe("fade");
    const fadeDraws = () =>
      calls.filter((c) =>
        c.body?.elements?.some(
          (e) =>
            isMotionElement(e.id) && e.section === "fade" && e.opacity === 100,
        ),
      );
    expect(fadeDraws()).toHaveLength(1);
    const firstFadeIndex = calls.findIndex((c) =>
      c.body?.elements?.some((e) => e.section === "fade"),
    );
    expect(
      calls
        .slice(0, firstFadeIndex)
        .filter((c) => c.path.endsWith("/assets/upload")),
    ).toHaveLength(2);
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
    expect(fadeDraws()).toHaveLength(1);
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
    ).toEqual([0, 0]);
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

  it("clears an empty queue directly without introducing a black interval", async () => {
    const f = await fixture();
    const before = calls.length;
    await f.end("old");
    const done = await f.wait((s) => !s.commands.length);
    expect(native.size).toBe(0);
    expect(calendar).toBe(f.coldCalendar + 1);
    expect(done.serviceMotion).toBeUndefined();
    expect(done.selected).toBeNull();
    expect(
      calls
        .slice(before)
        .filter((c) => c.method === "POST" && c.path.endsWith("/display/draw")),
    ).toEqual([]);
  });

  it("waits conservatively after a slow native-start ACK without restarting the animation", async () => {
    const f = await fixture();
    const upstream = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const body =
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/display/draw")
          ? ((await request.clone().json()) as { elements?: Element[] })
          : undefined;
      const result = await upstream(request);
      if (
        body?.elements?.length &&
        body.elements.every(
          (e) =>
            isMotionElement(e.id) && e.section === "fade" && e.opacity === 100,
        )
      ) {
        f.setClock(500);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return result;
    });
    await f.publish("incoming", "urgent");
    await f.wait((s) => !!s.serviceMotion?.nativeStarted);
    await f.advance(699);
    expect((await f.state()).serviceMotion?.phase).toBe("fade");
    await f.advance(700);
    expect((await f.state()).serviceMotion?.phase).toBe("black");
    await f.advance(899);
    expect((await f.state()).displaying).toBeNull();
    await f.advance(900);
    await f.wait((s) => !!s.displaying);
    expect(
      calls.filter((c) =>
        c.body?.elements?.some(
          (e) =>
            isMotionElement(e.id) && e.section === "fade" && e.opacity === 100,
        ),
      ),
    ).toHaveLength(1);
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
    expect(unmask).toHaveLength(3);
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
      for (const e of Object.values(s.nativeElements).filter((e) =>
        isMotionElement(e.id),
      )) {
        e.opacity = 0;
        native.set(e.id, { ...e });
      }
    });
    const previousMaskIds = [...native.keys()].filter(isMotionElement);
    await f.advance(0);
    expect((await f.state()).serviceMotion?.id).not.toBe(oldId);
    expect((await f.state()).serviceMotion?.phase).toBe("fade");
    const replay = calls
      .filter((c) =>
        c.body?.elements?.some(
          (e) => isMotionElement(e.id) && e.opacity === 100,
        ),
      )
      .at(-1)!.body!.elements!;
    expect(
      replay.every(
        (e) => e.type === "animation" && !previousMaskIds.includes(e.id),
      ),
    ).toBe(true);
    expect(previousMaskIds.every((id) => native.get(id)?.opacity === 0)).toBe(
      true,
    );
    expect(native.get("incoming-text")).toBeUndefined();
    await f.advance(199);
    expect((await f.state()).serviceMotion?.phase).toBe("fade");
    await f.advance(200);
    await f.advance(400);
    await f.wait(
      (s) => !!s.displaying && s.items[s.selected!].itemId === "incoming",
    );
    expect(calendar).toBe(f.coldCalendar);
  });

  it("reclaims transparent previous-exit widgets before ordinary content at the 128-ID bound", async () => {
    const f = await fixture();
    await f.publish("incoming", "urgent");
    await f.wait((s) => !!s.serviceMotion?.nativeStarted);
    const previousMaskIds = [...native.keys()].filter(isMotionElement);
    await f.mutate((s) => {
      s.serviceMotion!.phase = "handoff";
      s.commands = s.commands.filter((c) => c.kind !== "motion");
      for (const id of previousMaskIds) {
        s.nativeElements[id].opacity = 0;
        native.set(id, { ...s.nativeElements[id] });
      }
      for (let n = Object.keys(s.nativeElements).length; n < 128; n++) {
        const e: Element = {
          id: "capacity-old-" + n,
          type: "text",
          text: "old",
          font: "small",
          z_index: 40,
        };
        s.nativeElements[e.id] = e;
        s.elementExpiries[e.id] = {
          type: "text",
          expiresAt: Date.now() + 60_000,
        };
        native.set(e.id, e);
      }
    });
    const firstDelete = calls.length;
    await f.advance(0);
    const current = await f.wait((s) => !!s.serviceMotion?.nativeStarted);
    expect(
      calls
        .slice(firstDelete)
        .filter((c) => c.method === "DELETE")
        .flatMap((c) => c.body?.element_ids ?? []),
    ).toEqual(expect.arrayContaining(previousMaskIds));
    expect(previousMaskIds.every((id) => !native.has(id))).toBe(true);
    expect(native.has("old-text")).toBe(true);
    expect(Object.keys(current.nativeElements)).toHaveLength(128);
    expect(calendar).toBe(f.coldCalendar);
  });
  it.each(["no-animation-slots", "incoming-slot-bytes"])(
    "rechecks all five fallback masks after %s at 126 existing IDs",
    async (failure) => {
      const f = await fixture();
      const hash = "f".repeat(64);
      await f.mutate((s) => {
        s.slots =
          failure === "no-animation-slots"
            ? []
            : [
                ...[0, 1].map((slot) => ({
                  slot,
                  hash: String(slot).padStart(64, "a"),
                  type: "anim",
                  bytes: 1,
                  uploaded: true,
                })),
                ...Array.from({ length: 13 }, (_, n) => ({
                  slot: n + 2,
                  hash: String(n + 2).padStart(64, "b"),
                  type: "png",
                  bytes: Math.floor((2 * 1024 * 1024 - 6000) / 13),
                  uploaded: true,
                })),
              ];
        if (failure === "incoming-slot-bytes")
          s.assets[hash] = {
            hash,
            type: "png",
            bytes: 10000,
            data: btoa("x".repeat(10000)),
            owners: ["urgent"],
            usedAt: Date.now(),
          };
        for (let n = Object.keys(s.nativeElements).length; n < 126; n++) {
          const e: Element = {
            id: "fallback-old-" + n,
            type: "text",
            text: "old",
            font: "small",
            z_index: 40,
          };
          s.nativeElements[e.id] = e;
          s.elementExpiries[e.id] = {
            type: "text",
            expiresAt: Date.now() + 60_000,
          };
          native.set(e.id, e);
        }
      });
      const elements: Element[] =
        failure === "incoming-slot-bytes"
          ? [{ id: "incoming-image", type: "image", assetHash: hash }]
          : [{ id: "incoming-text", type: "text", text: "new", font: "small" }];
      await f.send("/publish", {
        epoch: f.epoch,
        instanceId: "mac",
        itemId: "fallback",
        version: 1,
        firstRecognizedAt: Date.now(),
        validUntil: Date.now() + 60_000,
        kind: "event",
        level: "urgent",
        title: "fallback",
        detail: "",
        scene: { entryDurationMs: 0, commands: [{ offsetMs: 0, elements }] },
      });
      const current = await f.wait((s) => s.serviceMotion?.phase === "black");
      expect(current.serviceMotion?.mode).toBe("fallback");
      const diagnostics = await f.diagnostics();
      expect(
        diagnostics.events.some(
          (event) =>
            event.kind === "motion_fallback" &&
            event.data.reason ===
              (failure === "no-animation-slots"
                ? "animation_slots"
                : "incoming_slot_bytes"),
        ),
      ).toBe(true);
      expect(Object.keys(current.nativeElements)).toHaveLength(128);
      expect(
        [...native.values()].filter((e) => isMotionElement(e.id)),
      ).toHaveLength(5);
      expect(
        calls
          .filter((c) => c.method === "DELETE")
          .flatMap((c) => c.body?.element_ids ?? []),
      ).toHaveLength(3);
      expect(
        calls.some((c) =>
          c.body?.elements?.some(
            (e) => isMotionElement(e.id) && e.type === "animation",
          ),
        ),
      ).toBe(false);
      expect(current.nativeRecoveryRequired).not.toBe(true);
      expect(calendar).toBe(f.coldCalendar);
    },
  );
});

async function preparedFixture() {
  const f = await fixture();
  const assets = [];
  for (const [width, height] of [
    [16, 14],
    [1, 1],
  ]) {
    const raw = nativeBlackHoldAsset(width, height),
      hash = await digest(raw);
    await f.send("/assets", { hash, type: "anim", data: base64(raw) });
    assets.push(hash);
  }
  const scene = {
    entryLeadMs: 200,
    entryDurationMs: 740,
    commands: [
      {
        offsetMs: 0,
        elements: [
          {
            id: "prepared-text",
            type: "text",
            text: "prepared",
            font: "small",
            scroll_start_delay: 200,
          },
          {
            id: "shared-service-entry",
            type: "animation",
            assetHash: assets[0],
            section: "hold",
            loop: false,
          },
        ],
      },
      {
        offsetMs: 740,
        elements: [
          {
            id: "shared-service-entry",
            type: "animation",
            assetHash: assets[1],
            section: "clear",
            loop: false,
          },
        ],
      },
    ],
  };
  const publishPrepared = (id: string, version = 1) =>
    f.send("/publish", {
      epoch: f.epoch,
      instanceId: "mac",
      itemId: id,
      version,
      firstRecognizedAt: Date.now(),
      validUntil: Date.now() + 60_000,
      kind: "event",
      level: "urgent",
      title: "Prepared",
      detail: "",
      scene,
    });
  const committed = () =>
    f.wait(
      (s) =>
        s.nativeElements[
          s.preparedEntryIds?.[scene.commands[0].elements[0].id] ??
            scene.commands[0].elements[0].id
        ] !== undefined &&
        Object.keys(s.nativeElements).some((id) =>
          id.startsWith(
            "control-service-motion-prepared-" + s.generation + "-",
          ),
        ),
    );
  const finish = async (requireMasks = true) => {
    if (requireMasks) await committed();
    else
      await f.wait(
        (s) =>
          s.nativeElements[
            s.preparedEntryIds?.[scene.commands[0].elements[0].id] ??
              scene.commands[0].elements[0].id
          ] !== undefined,
      );
    for (let n = 0; n < 10; n++) {
      const state = await f.state();
      if (state.displaying && !state.commands.length) return state;
      await f.advance(740);
    }
    throw new Error("prepared suffix did not settle");
  };
  return { ...f, scene, assets, publishPrepared, committed, finish };
}

async function fragmentedLegacyScene(
  f: Awaited<ReturnType<typeof preparedFixture>>,
  opacity?: number,
) {
  await f.mutate((s) => {
    s.slots = Array.from({ length: 16 }, (_, slot) => ({
      slot,
      hash: slot.toString(16).padStart(64, "f"),
      type: "png",
      bytes: 1,
      uploaded: true,
    }));
    const elements: Element[] = s.slots.map((slot) => ({
      id: "legacy-" + slot.slot,
      type: "image",
      assetHash: slot.hash,
    }));
    if (opacity !== undefined) elements.push(...motionElements(opacity));
    for (const e of elements) {
      s.nativeElements[e.id] = e;
      s.elementExpiries[e.id] = { type: e.type, expiresAt: Date.now() + 60000 };
      native.set(e.id, e);
    }
  });
}

describe("prepared single native commit", () => {
  it("commits a full animated scene through released PNG filenames while keeping the old view through preload", async () => {
    const f = await preparedFixture();
    await fragmentedLegacyScene(f);
    await f.mutate((s) => {
      for (const slot of s.slots)
        s.assets[slot.hash] = {
          hash: slot.hash,
          type: "png",
          bytes: 1,
          data: btoa("x"),
          owners: ["normal"],
          usedAt: Date.now(),
        };
      for (let n = 8; n < 16; n++) {
        delete s.nativeElements["legacy-" + n];
        delete s.elementExpiries["legacy-" + n];
        native.delete("legacy-" + n);
      }
    });
    const upstream = vi.mocked(globalThis.fetch).getMockImplementation()!;
    const uploaded: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/assets/upload")) {
        expect(native.get("old-text")?.text).toBe("old");
        for (let n = 0; n < 8; n++)
          expect(native.has("legacy-" + n)).toBe(true);
        expect(url.searchParams.get("file")).toMatch(/^slot-\d+\.png$/);
        const raw = new Uint8Array(await request.clone().arrayBuffer());
        expect(new TextDecoder().decode(raw.subarray(0, 8))).toBe("bicycle0");
        uploaded.push(await digest(raw));
      }
      return upstream(request);
    });
    await f.publishPrepared("reuse-png");
    const finished = await f.finish();
    expect(new Set(uploaded)).toEqual(
      new Set([...f.assets, ...preparedBlackAssets().map((a) => a.hash)]),
    );
    expect(finished.health.status).toBe("healthy");
    expect(finished.displaying?.generation).toBe(finished.generation);
    expect(finished.slots).toHaveLength(16);
    expect(finished.slots.every((slot) => slot.type === "png")).toBe(true);
    expect(
      (await f.diagnostics()).events.some(
        (e) =>
          e.kind === "command_ack" &&
          e.data.filenameType === "png" &&
          e.data.assetType === "anim",
      ),
    ).toBe(true);
  });

  it("keeps native inventory and pins until orphan recovery clear acknowledges", async () => {
    const f = await preparedFixture();
    await fragmentedLegacyScene(f, 100);
    const upstream = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let release!: () => void,
      held = false;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (
        !held &&
        request.method === "DELETE" &&
        new URL(request.url).pathname.endsWith("/display/draw")
      ) {
        held = true;
        const response = await upstream(request);
        await gate;
        return response;
      }
      return upstream(request);
    });
    const slots = structuredClone((await f.state()).slots);
    try {
      await f.publishPrepared("blocked");
      const pending = await f.observe(
        (s) =>
          held &&
          s.commands.some((c) => c.kind === "clear" && c.status === "inflight"),
      );
      expect(Object.keys(pending.nativeElements).some(isMotionElement)).toBe(
        true,
      );
      expect(
        Object.keys(pending.nativeElements).filter((id) =>
          id.startsWith("legacy-"),
        ),
      ).toHaveLength(16);
      expect(pending.slots).toEqual(slots);
      expect(pending.displaying).toBeNull();
      release();
      await f.finish(false);
    } finally {
      release();
    }
  });

  it("clears a cancelled opaque legacy mask before reusing released PNG filenames for the incoming scene", async () => {
    const f = await preparedFixture();
    await fragmentedLegacyScene(f, 100);
    const before = calls.length,
      calendars = calendar,
      slots = structuredClone((await f.state()).slots);
    await f.publishPrepared("blocked");
    const finished = await f.finish(false);
    const writes = calls.slice(before);
    expect(writes[0].method).toBe("DELETE");
    expect(writes[0].body).toBeUndefined();
    expect(
      writes.findIndex((c) => c.path.endsWith("/assets/upload")),
    ).toBeGreaterThan(0);
    expect(calendar).toBe(calendars + 1);
    expect(
      finished.slots.map((slot) => `${slot.slot}.${slot.type}`).sort(),
    ).toEqual(slots.map((slot) => `${slot.slot}.${slot.type}`).sort());
    expect(finished.items[finished.selected!].itemId).toBe("blocked");
    expect(finished.displaying?.generation).toBe(finished.generation);
    expect(finished.health.status).toBe("healthy");
    expect(
      (await f.diagnostics()).events.some(
        (e) =>
          e.kind === "recovery" &&
          e.data.reason === "orphan_legacy_mask" &&
          e.data.scope === "full",
      ),
    ).toBe(true);
  });

  it("retires transparent orphan masks selectively and keeps the visible pinned PNG scene", async () => {
    const f = await preparedFixture();
    await fragmentedLegacyScene(f, 0);
    const before = calls.length,
      calendars = calendar;
    await f.publishPrepared("blocked");
    const blocked = await f.wait(
      (s) =>
        s.health.status === "blocked" &&
        !Object.keys(s.nativeElements).some(isMotionElement),
    );
    const writes = calls.slice(before);
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("DELETE");
    expect(writes[0].body!.element_ids).toEqual(
      motionElements(0).map((e) => e.id),
    );
    expect(native.get("old-text")?.text).toBe("old");
    expect(
      [...native.keys()].filter((id) => id.startsWith("legacy-")),
    ).toHaveLength(16);
    expect(calendar).toBe(calendars);
    expect(blocked.displaying).toBeNull();
  });

  it("cleans a late old-generation black-mask ACK before retrying a prepared capacity failure", async () => {
    const f = await preparedFixture();
    await fragmentedLegacyScene(f);
    const upstream = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let release!: () => void,
      held = false;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (
        !held &&
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/display/draw")
      ) {
        const body = (await request.clone().json()) as { elements: Element[] };
        if (body.elements.some((e) => isMotionElement(e.id))) {
          held = true;
          const response = await upstream(request);
          await gate;
          return response;
        }
      }
      return upstream(request);
    });
    try {
      await f.publish("legacy", "urgent");
      const old = await f.observe(
        (s) => held && s.commands.some((c) => c.status === "inflight"),
      );
      await f.end("legacy");
      await f.publishPrepared("blocked");
      expect((await f.state()).generation).toBeGreaterThan(old.generation);
      expect([...native.values()].some((e) => isMotionElement(e.id))).toBe(
        true,
      );
      release();
      const finished = await f.finish(false);
      expect(finished.items[finished.selected!].itemId).toBe("blocked");
      expect(finished.displaying?.generation).toBe(finished.generation);
      expect(finished.health.status).toBe("healthy");
      expect(calls.some((c) => c.method === "DELETE" && !c.body)).toBe(true);
      expect(
        (await f.diagnostics()).events.some(
          (e) =>
            e.kind === "recovery" && e.data.reason === "orphan_legacy_mask",
        ),
      ).toBe(true);
    } finally {
      release();
    }
  });

  it("does not exceed the installed firmware's 100-widget prepared union with fresh players", async () => {
    const f = await preparedFixture();
    await f.mutate((s) => {
      for (let n = 1; n < 100; n++) {
        const e: Element = {
          id: "old-inline-" + n,
          type: "text",
          text: "old",
          font: "small",
        };
        s.nativeElements[e.id] = e;
        s.elementExpiries[e.id] = {
          type: "text",
          expiresAt: Date.now() + 60000,
        };
        native.set(e.id, e);
      }
    });
    const before = calls.length;
    await f.publishPrepared("blocked");
    const blocked = await f.wait((s) => s.health.status === "blocked");
    expect(Object.keys(blocked.nativeElements)).toHaveLength(100);
    expect(calls.slice(before)).toEqual([]);
    expect(
      (await f.diagnostics()).events.some(
        (e) =>
          e.kind === "motion_fallback" &&
          e.data.reason === "prepared_native_capacity" &&
          e.data.expectedBlackMs === 0,
      ),
    ).toBe(true);
  });
  it("defers retirement HTTP until at least 200ms after a fast commit ACK without using it to reveal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now(),
        f = await preparedFixture(),
        before = calls.length;
      await f.publishPrepared("fast");
      const committed = await f.committed();
      expect(committed.commands[0].kind).toBe("clear");
      expect(committed.commands[0].dueAt).toBeGreaterThanOrEqual(start + 200);
      expect(calls.slice(before).some((c) => c.method === "DELETE")).toBe(
        false,
      );
      vi.setSystemTime(start + 199);
      await f.alarm();
      expect(calls.slice(before).some((c) => c.method === "DELETE")).toBe(
        false,
      );
      const afterCommit = calls.length;
      vi.setSystemTime(start + 200);
      await f.alarm();
      await f.wait((s) => !s.nativeElements["old-text"]);
      expect(calls.slice(afterCommit).map((c) => c.method)).toEqual(["DELETE"]);
      expect(
        [...native.keys()].filter((id) =>
          id.startsWith("control-service-motion-prepared-"),
        ),
      ).toHaveLength(2);
      expect(
        calls
          .slice(before)
          .filter(
            (c) =>
              c.method === "POST" &&
              c.body?.elements?.some((e) => isMotionElement(e.id)),
          ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("commits a same-name different-type incoming widget under a fresh ID without clearing the old view first", async () => {
    const f = await preparedFixture();
    f.scene.commands[0].elements[0] = {
      id: "old-text",
      type: "rectangle",
      width: 1,
      height: 1,
    } as never;
    const before = calls.length;
    await f.publishPrepared("type-change");
    const finished = await f.finish();
    const physical = finished.preparedEntryIds!["old-text"];
    expect(physical).not.toBe("old-text");
    expect(native.get(physical)?.type).toBe("rectangle");
    expect(finished.health.status).toBe("healthy");
    const writes = calls.slice(before),
      commit = writes.findIndex((c) =>
        c.body?.elements?.some((e) => e.id === physical),
      );
    expect(
      writes.slice(0, commit).every((c) => c.path.endsWith("/assets/upload")),
    ).toBe(true);
    expect(writes[commit].body!.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "old-text", type: "text", text: " " }),
        expect.objectContaining({ id: physical, type: "rectangle" }),
      ]),
    );
    expect(
      (await f.diagnostics()).events.some(
        (e) =>
          e.kind === "motion_fallback" &&
          e.data.reason === "prepared_type_conflict",
      ),
    ).toBe(false);
  });

  it("keeps a late old-widget ACK separate from a prepared incoming logical ID", async () => {
    const f = await preparedFixture();
    const upstream = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let release!: () => void,
      held = false;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (!held && new URL(request.url).pathname.endsWith("/assets/upload")) {
        held = true;
        const response = await upstream(request);
        await gate;
        return response;
      }
      return upstream(request);
    });
    try {
      await f.publishPrepared("late-type");
      await f.observe(
        (s) =>
          held &&
          s.commands.some(
            (c) => c.kind === "upload" && c.status === "inflight",
          ),
      );
      await f.mutate((s) => {
        const e: Element = {
          id: "prepared-text",
          type: "rectangle",
          width: 1,
          height: 1,
        };
        s.nativeElements[e.id] = e;
        s.elementExpiries[e.id] = {
          type: e.type,
          expiresAt: Date.now() + 60000,
        };
        native.set(e.id, e);
      });
      release();
      const finished = await f.finish();
      expect(
        native.get(finished.preparedEntryIds!["prepared-text"])?.type,
      ).toBe("text");
      expect(finished.health.status).toBe("healthy");
      expect(
        (await f.diagnostics()).events.some(
          (e) =>
            e.kind === "motion_fallback" &&
            e.data.reason === "prepared_type_conflict",
        ),
      ).toBe(false);
    } finally {
      release();
    }
  });

  it("does not stage an entrance under old widgets after a prepared draw-capacity conflict", async () => {
    const f = await preparedFixture(),
      before = calls.length;
    f.scene.commands[0].elements = Array.from({ length: 32 }, (_, n) => ({
      id: "new-" + n,
      type: "text",
      text: "new",
      font: "small",
    })) as never;
    await f.publishPrepared("blocked");
    const blocked = await f.wait((s) => s.health.status === "blocked");
    expect(native.get("old-text")?.text).toBe("old");
    expect(
      calls.slice(before).some((c) => c.path.endsWith("/display/draw")),
    ).toBe(false);
    expect(blocked.commands[0].attempts).toBeGreaterThan(0);
    expect(
      (await f.diagnostics()).events.some(
        (e) =>
          e.kind === "motion_fallback" &&
          e.data.reason === "prepared_draw_capacity" &&
          e.data.expectedBlackMs === 0,
      ),
    ).toBe(true);
  });
  it("omits only the masks when their historical slots are unavailable, keeping the old view until the normal commit", async () => {
    const f = await preparedFixture();
    await f.mutate((s) => {
      s.slots = [];
    });
    const before = calls.length;
    await f.publishPrepared("fallback");
    await f.wait(
      (s) =>
        native.has(s.preparedEntryIds!["prepared-text"]) &&
        !s.commands.some((c) => c.handoff),
    );
    const sent = calls.slice(before),
      firstDraw = sent.findIndex(
        (c) => c.method === "POST" && c.path.endsWith("/display/draw"),
      );
    expect(
      sent.slice(0, firstDraw).every((c) => c.path.endsWith("/assets/upload")),
    ).toBe(true);
    expect(
      sent
        .flatMap((c) => c.body?.elements ?? [])
        .some((e) => e.id.startsWith("control-service-motion-prepared-")),
    ).toBe(false);
    expect(
      (await f.diagnostics()).events.some(
        (e) =>
          e.kind === "motion_fallback" &&
          e.data.reason === "animation_slots" &&
          e.data.expectedBlackMs === 0,
      ),
    ).toBe(true);
  });
  it("keeps the outgoing view through every preload and releases masks locally without a later unmask draw", async () => {
    const f = await preparedFixture(),
      start = calls.length;
    const upstream = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let preloads = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/assets/upload")) {
        expect(native.get("old-text")?.text).toBe("old");
        expect([...native.keys()].some(isMotionElement)).toBe(false);
        preloads++;
      }
      return upstream(request);
    });
    await f.publishPrepared("one");
    const committed = await f.finish();
    const sent = calls.slice(start),
      firstDraw = sent.findIndex(
        (c) => c.method === "POST" && c.path.endsWith("/display/draw"),
      );
    expect(preloads).toBe(4);
    expect(
      sent.slice(0, firstDraw).every((c) => c.path.endsWith("/assets/upload")),
    ).toBe(true);
    const commit = sent[firstDraw].body!.elements!;
    expect(commit.find((e) => e.id === "old-text")).toMatchObject({
      text: " ",
      scroll_rate: 0,
    });
    expect(
      commit.find((e) => e.id === committed.preparedEntryIds!["prepared-text"]),
    ).toMatchObject({
      scroll_start_delay: 200,
    });
    const masks = commit.filter((e) => isMotionElement(e.id));
    expect(masks).toHaveLength(2);
    expect(masks.map((e) => e.section)).toEqual(["hold", "hold"]);
    expect(masks.map((e) => e.assetHash)).toEqual([undefined, undefined]); // Native paths only.
    expect(
      masks.every(
        (e) => e.z_index === 255 && e.opacity === 100 && e.loop === false,
      ),
    ).toBe(true);
    const ids = new Set(masks.map((e) => e.id));
    expect(
      sent.filter(
        (c) =>
          c.method === "POST" && c.body?.elements?.some((e) => ids.has(e.id)),
      ),
    ).toHaveLength(1);
    expect(
      sent.some(
        (c) =>
          c.method === "DELETE" &&
          c.body?.element_ids?.some((id) => ids.has(id)),
      ),
    ).toBe(false);
    const state = await f.state();
    expect(state.serviceMotion).toBeUndefined();
    expect(state.items[state.selected!].scene.commands[0].elements[1].id).toBe(
      "shared-service-entry",
    );
    expect(state.slots.length).toBeLessThanOrEqual(16);
    expect(state.slots.reduce((n, s) => n + s.bytes, 0)).toBeLessThanOrEqual(
      2 * 1024 * 1024,
    );
    expect(
      (await f.diagnostics()).events.some(
        (e) =>
          e.kind === "prepared_handoff" &&
          e.data.expectedBlackMs === 200 &&
          e.data.pendingUploads === 0,
      ),
    ).toBe(true);
    expect(calendar).toBe(f.coldCalendar);
  });

  it("maps logical updates, renewal and recovery without replaying an already visible entrance", async () => {
    const f = await preparedFixture();
    await f.publishPrepared("one");
    await f.finish();
    const first = await f.state(),
      physical = first.preparedEntryIds!["shared-service-entry"];
    const before = calls.length;
    await f.send("/update", {
      epoch: f.epoch,
      instanceId: "mac",
      itemId: "one",
      version: 2,
      generation: first.generation,
      elements: [f.scene.commands[1].elements[0]],
      scene: f.scene,
    });
    await f.wait(
      (s) => s.items[s.selected!].version === 2 && !s.commands.length,
    );
    expect(native.has("shared-service-entry")).toBe(false);
    expect(native.get(physical)?.section).toBe("clear");
    await f.mutate((s) => {
      s.elementExpiries[physical].expiresAt = Date.now() + 1000;
    });
    await f.advance(740); // Renewal is scheduled by alarm(), not GET /snapshot.
    await f.wait(
      (s) => s.elementExpiries[physical].expiresAt > Date.now() + 50000,
    );
    expect(
      calls
        .slice(before)
        .flatMap((c) => c.body?.elements ?? [])
        .filter((e) => e.id === physical)
        .every((e) => e.section === "clear"),
    ).toBe(true);
    await f.mutate((s) => {
      s.nativeRecoveryRequired = true;
    });
    await f.advance(0);
    await f.finish();
    const recovered = await f.state();
    expect(recovered.preparedEntryIds!["shared-service-entry"]).not.toBe(
      physical,
    );
    expect(
      native.has(recovered.preparedEntryIds!["shared-service-entry"]),
    ).toBe(true);
  });

  it("drops the old physical entry mapping after a late old-generation commit acknowledgement", async () => {
    const f = await preparedFixture(),
      upstream = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let release!: () => void,
      held = false;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (
        !held &&
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/display/draw")
      ) {
        const body = (await request.clone().json()) as { elements: Element[] };
        if (
          body.elements.some((e) =>
            e.id.startsWith("control-service-motion-prepared-"),
          )
        ) {
          held = true;
          await blocked;
        }
      }
      return upstream(request);
    });
    await f.publishPrepared("one");
    const first = await f.observe(
      (s) => held && s.commands.some((c) => c.status === "inflight"),
    );
    const oldPhysical = first.preparedEntryIds!["shared-service-entry"];
    // A peer in the same urgent source does not preempt its active occurrence.
    // End that occurrence while its native ACK is still held, then select two.
    await f.end("one");
    await f.publishPrepared("two");
    const newer = await f.state();
    expect(newer.preparedEntryIds!["shared-service-entry"]).not.toBe(
      oldPhysical,
    );
    release();
    const done = await f.finish();
    expect(done.items[done.selected!].itemId).toBe("two");
    expect(native.has(oldPhysical)).toBe(false);
    expect(native.has(done.preparedEntryIds!["shared-service-entry"])).toBe(
      true,
    );
    expect(done.nativeRecoveryRequired).not.toBe(true);
  });

  it("keeps all sixteen pinned legacy PNGs when a prepared scene cannot coexist", async () => {
    const f = await preparedFixture();
    await f.mutate((s) => {
      s.slots = Array.from({ length: 16 }, (_, slot) => ({
        slot,
        hash: slot.toString(16).padStart(64, "f"),
        type: "png",
        bytes: 1,
        uploaded: true,
      }));
      for (const slot of s.slots) {
        const e: Element = {
          id: "legacy-" + slot.slot,
          type: "image",
          assetHash: slot.hash,
        };
        s.nativeElements[e.id] = e;
        s.elementExpiries[e.id] = {
          type: "image",
          expiresAt: Date.now() + 60000,
        };
        native.set(e.id, e);
      }
    });
    const before = calls.length,
      old = structuredClone((await f.state()).slots);
    await f.publishPrepared("blocked");
    const blocked = await f.wait((s) => s.health.status === "blocked");
    expect(blocked.slots).toEqual(old);
    expect(native.get("old-text")?.text).toBe("old");
    expect(
      [...native.keys()].filter((id) => id.startsWith("legacy-")),
    ).toHaveLength(16);
    expect(calls.slice(before)).toEqual([]);
    expect(blocked.commands[0].prepared).toBe("fallback");
    expect(blocked.commands[0].attempts).toBeGreaterThan(0);
    expect(
      (await f.diagnostics()).events.some(
        (e) =>
          e.kind === "motion_fallback" &&
          e.data.reason === "incoming_slot_count" &&
          e.data.expectedBlackMs === 0,
      ),
    ).toBe(true);
  });
});
