import { describe, it, expect } from "vitest";
import {
  createState,
  validateScene,
  enqueue,
  registerService,
  publish,
  finishItem,
  type Element,
} from "../src/model";
import { digest } from "../src/security";
import {
  nativeBlackHoldAsset,
  preparedBlackAssets,
  preparedBlackElements,
  materializePreparedElements,
  setPreparedEntryIds,
  hideObsoleteElement,
  upgradePreparedElementIds,
  PREPARED_ENTRY_PREFIX,
} from "../src/prepared-handoff";
import { pinnedSlots, referencedHashes } from "../src/assets";

describe("prepared device-local black hold", () => {
  it("matches the actual-device probe bytes and independently decodes ten black samples then transparent", async () => {
    for (const [index, width, height, length] of [
      [0, 72, 16, 688],
      [1, 160, 80, 5693],
    ]) {
      const raw = nativeBlackHoldAsset(width, height),
        view = new DataView(raw.buffer),
        asset = preparedBlackAssets()[index];
      expect(raw.length).toBe(length);
      expect(await digest(raw)).toBe(asset.hash);
      expect(raw[12]).toBe(50);
      expect(view.getUint32(28, true)).toBe(11);
      expect(view.getUint32(32, true)).toBe(11);
      const sections = new Map<
        string,
        { start: number; end: number; offset: number }
      >();
      let offset = 36;
      for (let n = 0; n < 3; n++) {
        const end = raw.indexOf(0, offset + 13),
          name = new TextDecoder().decode(raw.slice(offset + 13, end));
        sections.set(name, {
          start: view.getUint32(offset, true),
          end: view.getUint32(offset + 4, true),
          offset: view.getUint32(offset + 8, true),
        });
        offset = end + 1;
      }
      expect(sections.get("hold")?.start).toBe(0);
      expect(sections.get("hold")?.end).toBe(10);
      expect(sections.get("clear")?.start).toBe(10);
      for (let frame = 0; frame < 11; frame++) {
        expect(raw[offset]).toBe(1);
        expect(raw[offset + 1]).toBe(1);
        const length = view.getUint16(offset + 2, true);
        let pixels = 0;
        for (let p = offset + 4; p < offset + 4 + length; p += 5) {
          expect(raw[p]).toBeGreaterThan(0);
          expect(raw[p]).toBeLessThanOrEqual(127);
          expect([...raw.slice(p + 1, p + 5)]).toEqual([
            0,
            0,
            0,
            frame === 10 ? 0 : 255,
          ]);
          pixels += raw[p];
        }
        expect(pixels).toBe(width * height);
        offset += 4 + length;
      }
      expect(offset).toBe(raw.length);
    }
    expect(preparedBlackElements(3).map((e) => e.id)).not.toEqual(
      preparedBlackElements(4).map((e) => e.id),
    );
  });

  const scene = {
    entryLeadMs: 200,
    entryDurationMs: 740,
    commands: [
      {
        offsetMs: 0,
        elements: [
          {
            id: "entry",
            type: "animation",
            assetHash: "a".repeat(64),
            loop: false,
          },
        ],
      },
      {
        offsetMs: 740,
        elements: [
          {
            id: "entry",
            type: "animation",
            assetHash: "b".repeat(64),
            loop: false,
          },
        ],
      },
    ],
  };
  it("accepts only explicit 0/200 lead covered by the entrance duration", () => {
    expect(validateScene(scene).entryLeadMs).toBe(200);
    expect(validateScene({ ...scene, entryLeadMs: 0 }).entryLeadMs).toBe(0);
    expect(() => validateScene({ ...scene, entryLeadMs: 201 })).toThrow(
      "INVALID_ENTRY_LEAD",
    );
    expect(() => validateScene({ ...scene, entryDurationMs: 100 })).toThrow(
      "INVALID_ENTRY_LEAD",
    );
    expect(() =>
      validateScene({
        ...scene,
        commands: [
          {
            offsetMs: 0,
            elements: [
              {
                ...scene.commands[0].elements[0],
                id: PREPARED_ENTRY_PREFIX + "fake",
              },
            ],
          },
        ],
      }),
    ).toThrow("COMPOSITOR_LAYER_RESERVED");
  });

  it("maps first non-loop players for a generation and their later clear without changing source IDs", () => {
    const s = createState("mapping");
    registerService(
      s,
      { id: "test", name: "Test", template: "notifier" },
      "hash",
      "epoch",
      100,
    );
    publish(
      s,
      "test",
      {
        instanceId: "mac",
        epoch: "epoch",
        itemId: "one",
        version: 1,
        firstRecognizedAt: 100,
        kind: "event",
        level: "info",
        title: "one",
        detail: "",
        validUntil: 100000,
        scene,
      },
      100,
    );
    expect(s.serviceMotion).toBeUndefined();
    expect(
      s.commands.some((c) => c.kind === "clear" || c.kind === "motion"),
    ).toBe(false);
    const physical = s.preparedEntryIds!.entry;
    expect(s.commands[0].prepared).toBe("pending");
    expect(
      s.commands
        .filter((c) => c.kind === "draw")
        .every((c) => c.elements![0].id === physical),
    ).toBe(true);
    expect(s.items[s.selected!].scene.commands[0].elements[0].id).toBe("entry");
    expect(
      materializePreparedElements(s, [{ id: "entry", type: "animation" }])[0]
        .id,
    ).toBe(physical);
    enqueue(s, {
      generation: s.generation,
      kind: "draw",
      dueAt: 100,
      elements: scene.commands[1].elements as never,
      refresh: true,
    });
    expect(s.commands.at(-1)!.elements![0].id).toBe(physical);
    s.generation++;
    setPreparedEntryIds(s);
    expect(s.preparedEntryIds!.entry).not.toBe(physical);
    finishItem(s, s.selected!, "resolved", 1, 101);
    expect(s.serviceMotion).toBeUndefined();
    expect(s.commands.filter((c) => c.kind === "motion")).toHaveLength(0);
    expect(s.commands.at(-1)?.kind).toBe("clear");
  });

  it("pins pending internal assets even before their masks have drawn", () => {
    const s = createState("pin"),
      hash = preparedBlackAssets()[0].hash;
    s.slots = [{ slot: 0, hash, type: "anim", bytes: 688, uploaded: false }];
    enqueue(s, {
      generation: 0,
      kind: "draw",
      dueAt: 0,
      prepared: "pending",
      preparedAssetHashes: [hash],
    });
    expect(referencedHashes(s).has(hash)).toBe(true);
    expect(pinnedSlots(s).has(0)).toBe(true);
  });

  function allWidgetState() {
    const s = createState("all-widgets");
    registerService(
      s,
      { id: "test", name: "Test", template: "notifier" },
      "hash",
      "epoch",
      100,
    );
    publish(
      s,
      "test",
      {
        instanceId: "mac",
        epoch: "epoch",
        itemId: "one",
        version: 1,
        firstRecognizedAt: 100,
        kind: "event",
        level: "info",
        title: "one",
        detail: "",
        validUntil: 100000,
        scene: {
          ...scene,
          commands: [
            {
              offsetMs: 0,
              elements: [
                ...scene.commands[0].elements,
                { id: "title", type: "text", text: "TEST", font: "small" },
                {
                  id: "loop",
                  type: "animation",
                  assetHash: "c".repeat(64),
                  loop: true,
                },
              ],
            },
            {
              offsetMs: 740,
              elements: [
                ...scene.commands[1].elements,
                {
                  id: "constructor",
                  type: "text",
                  text: "LATER",
                  font: "small",
                },
              ],
            },
          ],
        },
      },
      100,
    );
    return s;
  }

  it("gives static, looping and later widgets stable bounded IDs as well as entrance players", () => {
    const s = allWidgetState(),
      mapping = { ...s.preparedEntryIds };
    expect(Object.keys(mapping).sort()).toEqual([
      "constructor",
      "entry",
      "loop",
      "title",
    ]);
    expect(new Set(Object.values(mapping)).size).toBe(4);
    expect(
      Object.values(mapping).every(
        (id) =>
          id.startsWith(PREPARED_ENTRY_PREFIX + s.generation + "-") &&
          id.length <= 64,
      ),
    ).toBe(true);
    const elements: Element[] = [
      { id: "title", type: "text", text: "UPDATE", font: "small" },
      { id: "loop", type: "animation", loop: true },
    ];
    expect(
      materializePreparedElements(s, materializePreparedElements(s, elements)),
    ).toEqual(materializePreparedElements(s, elements));
    expect(s.preparedEntryIds).toEqual(mapping);
    expect(s.items[s.selected!].scene.commands[0].elements[1].id).toBe("title");
  });

  it("upgrades an old pending mapping without altering existing players, in-flight writes or native proof", () => {
    const s = allWidgetState(),
      entry = PREPARED_ENTRY_PREFIX + s.generation + "-2";
    s.preparedEntryIds = { entry };
    s.commands = [];
    for (const c of s.items[s.selected!].scene.commands)
      enqueue(s, {
        generation: s.generation,
        kind: "draw",
        dueAt: 100,
        elements: c.elements,
      });
    s.commands.push({
      id: 100,
      generation: s.generation - 1,
      kind: "draw",
      status: "inflight",
      attempts: 1,
      dueAt: 100,
      elements: [{ id: "title", type: "rectangle" }],
    });
    s.nativeElements.title = { id: "title", type: "rectangle" };
    expect(upgradePreparedElementIds(s, s.commands[0].elements!)).toBe(3);
    expect(s.preparedEntryIds.entry).toBe(entry);
    expect(new Set(Object.values(s.preparedEntryIds)).size).toBe(4);
    expect(s.commands[0].elements![1].id).toBe(s.preparedEntryIds.title);
    expect(s.commands.at(-1)!.elements![0].id).toBe("title");
    expect(s.nativeElements.title.type).toBe("rectangle");
    expect(s.displaying).toBeNull();
    expect(upgradePreparedElementIds(s, s.commands[0].elements!)).toBe(0);
  });

  it("hides every obsolete type in the commit, including widgets without native opacity", () => {
    expect(
      hideObsoleteElement({
        id: "text",
        type: "text",
        text: "old",
        scroll_rate: 300,
      }),
    ).toMatchObject({ text: " ", scroll_rate: 0 });
    expect(hideObsoleteElement({ id: "image", type: "image" })).toMatchObject({
      opacity: 0,
    });
    expect(
      hideObsoleteElement({ id: "counter", type: "countdown" }),
    ).toMatchObject({ x: 4095, y: 4095, align: "top_left" });
  });
});
