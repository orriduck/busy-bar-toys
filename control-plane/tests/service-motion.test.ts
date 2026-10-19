import { describe, expect, it } from "vitest";
import {
  acceptDisplay,
  createState,
  finishItem,
  publish,
  registerService,
  validateElements,
} from "../src/model";
import {
  BLACK_MS,
  FADE_MS,
  ServiceMotionClock,
  isMotionElement,
  motionElements,
  motionOpacity,
  type ServiceMotion,
} from "../src/service-motion";

describe("shared service exit timeline", () => {
  it("samples 199/200ms fade and 399/400ms total boundaries from elapsed time", () => {
    let now = 0;
    const clock = new ServiceMotionClock(() => now);
    const motion: ServiceMotion = { id: 1, phase: "fade", elapsedMs: 0 };
    expect(motionOpacity(clock.elapsed(motion))).toBe(0);
    now = 199;
    expect(motionOpacity(clock.elapsed(motion))).toBe(99);
    now = 200;
    expect(motionOpacity(clock.elapsed(motion))).toBe(100);
    // The dispatcher enters this phase only after the opaque native ACK.
    motion.phase = "black";
    motion.elapsedMs = 0;
    clock.elapsed(motion);
    now = 399;
    expect(clock.elapsed(motion)).toBe(BLACK_MS - 1);
    now = 400;
    expect(clock.elapsed(motion)).toBe(BLACK_MS);
  });

  it("skips missed samples instead of replaying frames or accumulating frame counts", () => {
    let now = 10;
    const clock = new ServiceMotionClock(() => now);
    const motion: ServiceMotion = { id: 1, phase: "fade", elapsedMs: 0 };
    clock.elapsed(motion);
    now = 190;
    expect(motionOpacity(clock.elapsed(motion))).toBe(90);
    now = 800;
    expect(motionOpacity(clock.elapsed(motion))).toBe(100);
    expect(motion.elapsedMs).toBe(790);
    expect(FADE_MS).toBe(200);
  });

  it("never reverses on a backwards clock sample and resumes persisted progress", () => {
    let now = 40;
    const clock = new ServiceMotionClock(() => now);
    const motion: ServiceMotion = { id: 1, phase: "fade", elapsedMs: 75 };
    expect(clock.elapsed(motion)).toBe(75);
    now = 80;
    expect(clock.elapsed(motion)).toBe(115);
    now = 50;
    expect(clock.elapsed(motion)).toBe(115);
    const restarted = new ServiceMotionClock(() => 1);
    expect(restarted.elapsed(motion)).toBe(115);
  });

  it("covers the full 72x16 front and 160x80 back above native scrolling text", () => {
    const masks = motionElements(65);
    expect(validateElements(masks)).toEqual(masks);
    expect(masks).toHaveLength(5);
    expect(
      masks.every(
        (e) =>
          isMotionElement(e.id) &&
          e.type === "xpmbitmap" &&
          e.opacity === 65 &&
          Number(e.z_index) > 35,
      ),
    ).toBe(true);
    expect(masks.filter((e) => e.display === "back").map((e) => e.y)).toEqual([
      0, 20, 40, 60,
    ]);
    expect(masks.every((e) => String(e.data).includes("B c #000000"))).toBe(
      true,
    );
    expect(motionElements(100).every((e) => e.opacity === 100)).toBe(true);
  });
});

const start = 1_800_000_000_000;
function fixture() {
  const s = createState("motion-test");
  for (const id of ["normal", "urgent"])
    registerService(
      s,
      {
        id,
        name: id,
        template: "notifier",
        ...(id === "urgent" ? { priorityGroup: "interception" } : {}),
      },
      "hash",
      "epoch",
      start,
    );
  return s;
}
function item(id: string, level = "info", version = 1) {
  return {
    instanceId: "mac",
    epoch: "epoch",
    itemId: id,
    version,
    firstRecognizedAt: start,
    kind: "event",
    level,
    title: id,
    detail: "",
    validUntil: start + 100_000,
    scene: {
      entryDurationMs: 0,
      commands: [
        {
          offsetMs: 0,
          elements: [{ id: "view", type: "text", text: id, font: "small" }],
        },
      ],
    },
  };
}
function native(s: ReturnType<typeof fixture>) {
  s.nativeElements.view = {
    id: "view",
    type: "text",
    text: "old high text",
    font: "small",
    z_index: 35,
  };
  s.elementExpiries.view = { type: "text", expiresAt: start + 60_000 };
  s.commands = [];
}

describe("service motion scheduling", () => {
  it("does not animate cold start and creates an independent exit before an empty clear", () => {
    const s = fixture();
    publish(s, "normal", item("one"), start);
    expect(s.serviceMotion).toBeUndefined();
    expect(s.commands.map((c) => c.kind)).toEqual(["clear", "draw"]);
    native(s);
    finishItem(s, s.selected!, "resolved", 1, start + 1);
    expect(s.selected).toBeNull();
    expect(s.commands.map((c) => c.kind)).toEqual(["motion", "clear"]);
    expect(s.serviceMotion?.phase).toBe("fade");
  });

  it("keeps the original exit and elapsed progress during urgent candidate churn", () => {
    const s = fixture();
    publish(s, "normal", item("one"), start);
    acceptDisplay(s, s.generation, start);
    native(s);
    publish(s, "urgent", item("two", "urgent"), start + 100);
    const motion = s.serviceMotion!;
    motion.elapsedMs = 150;
    finishItem(s, s.selected!, "resolved", 1, start + 150);
    publish(s, "urgent", item("three", "urgent"), start + 180);
    expect(s.serviceMotion).toBe(motion);
    expect(s.serviceMotion?.elapsedMs).toBe(150);
    expect(s.items[s.selected!].itemId).toBe("three");
    expect(s.commands.filter((c) => c.kind === "motion")).toHaveLength(1);
    expect(s.items[JSON.stringify(["normal", "mac", "one"])].remainingMs).toBe(
      9900,
    );
    expect(s.displaying).toBeNull();
  });

  it("does not reset an exit or the generation when the selected item updates", () => {
    const s = fixture();
    publish(s, "normal", item("one"), start);
    native(s);
    publish(s, "urgent", item("two", "urgent"), start + 1);
    const motion = s.serviceMotion!;
    motion.phase = "black";
    motion.elapsedMs = 180;
    const generation = s.generation;
    publish(s, "urgent", item("two", "urgent", 2), start + 5);
    expect(s.generation).toBe(generation);
    expect(s.serviceMotion).toBe(motion);
    expect(s.serviceMotion?.elapsedMs).toBe(180);
  });

  it("does not start another exit while opaque handoff masks remain", () => {
    const s = fixture();
    publish(s, "normal", item("one"), start);
    native(s);
    publish(s, "urgent", item("two", "urgent"), start + 1);
    const id = s.serviceMotion!.id;
    s.serviceMotion!.phase = "handoff";
    finishItem(s, s.selected!, "resolved", 1, start + 2);
    expect(s.serviceMotion?.id).toBe(id);
    expect(s.commands.some((c) => c.kind === "motion")).toBe(false);
    expect(s.items[s.selected!].itemId).toBe("one");
  });

  it("starts a fresh bounded exit when transparent handoff masks prove the incoming view is visible", () => {
    const s = fixture();
    publish(s, "normal", item("one"), start);
    native(s);
    publish(s, "urgent", item("two", "urgent"), start + 1);
    const oldId = s.serviceMotion!.id;
    s.serviceMotion!.phase = "handoff";
    for (const e of motionElements(0)) {
      s.nativeElements[e.id] = e;
      s.elementExpiries[e.id] = { type: "xpmbitmap", expiresAt: start + 60000 };
    }
    finishItem(s, s.selected!, "resolved", 1, start + 2);
    expect(s.serviceMotion?.phase).toBe("fade");
    expect(s.serviceMotion?.id).not.toBe(oldId);
    const fresh = s.serviceMotion!;
    fresh.elapsedMs = 125;
    publish(s, "urgent", item("three", "urgent"), start + 3);
    expect(s.serviceMotion).toBe(fresh);
    expect(s.serviceMotion?.elapsedMs).toBe(125);
  });
});
