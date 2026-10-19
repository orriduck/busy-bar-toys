import type { Element, State } from "./model";

export const PREPARED_ENTRY_PREFIX = "control-prepared-entry-";
export const PREPARED_BLACK_MS = 200;
// Installed firmware 1.2.4 canvas.h; keep the legacy model's 128-ID bound intact.
export const PREPARED_NATIVE_ELEMENT_LIMIT = 100;
const PREFIX = "control-service-motion-prepared-";

/** RLE BGRA bicycle0: ten 20ms black samples, then a retained transparent one. */
export function nativeBlackHoldAsset(
  width: number,
  height: number,
): Uint8Array {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 255 ||
    height > 255 ||
    width * height * 4 > 65535
  )
    throw new Error("Invalid native hold dimensions");
  const frameBytes = Math.ceil((width * height) / 127) * 5,
    recordBytes = frameBytes + 4;
  const sections = [
    { name: "default", start: 0, end: 10, offset: 0 },
    { name: "hold", start: 0, end: 10, offset: 0 },
    { name: "clear", start: 10, end: 10, offset: 10 * recordBytes },
  ];
  const sectionBytes = sections.reduce((n, s) => n + 14 + s.name.length, 0),
    result = new Uint8Array(36 + sectionBytes + 11 * recordBytes),
    view = new DataView(result.buffer);
  result.set(new TextEncoder().encode("bicycle0"));
  result[9] = width;
  result[10] = height;
  result[11] = 2;
  result[12] = 50;
  view.setUint16(13, frameBytes, true);
  view.setUint32(16, sectionBytes, true);
  view.setUint32(20, 11 * recordBytes, true);
  view.setUint32(24, sections.length, true);
  view.setUint32(28, 11, true);
  view.setUint32(32, 11, true);
  let offset = 36;
  for (const section of sections) {
    view.setUint32(offset, section.start, true);
    view.setUint32(offset + 4, section.end, true);
    view.setUint32(offset + 8, 36 + sectionBytes + section.offset, true);
    result[offset + 12] = 1;
    result.set(new TextEncoder().encode(section.name), offset + 13);
    offset += 14 + section.name.length;
  }
  for (let frame = 0; frame < 11; frame++) {
    result[offset] = 1;
    result[offset + 1] = 1;
    view.setUint16(offset + 2, frameBytes, true);
    for (
      let pixel = offset + 4, remaining = width * height;
      remaining > 0;
      pixel += 5
    ) {
      result[pixel] = Math.min(127, remaining);
      result[pixel + 4] = frame === 10 ? 0 : 255;
      remaining -= result[pixel];
    }
    offset += recordBytes;
  }
  return result;
}

const HASHES = {
  front: "d2ea65bfdffa8dee7c459552ab48054d296bfc0ad49846bd6b003b0052e0be35",
  back: "75bc573cfb04986187f673acac4cd26fce19670b2f095c9a469909d30f344dac",
};
let cached:
  { hash: string; type: string; bytes: number; data: string }[] | undefined;
export function preparedBlackAssets() {
  return (cached ??= (
    [
      ["front", 72, 16],
      ["back", 160, 80],
    ] as const
  ).map(([display, width, height]) => {
    const raw = nativeBlackHoldAsset(width, height);
    let binary = "";
    for (const byte of raw) binary += String.fromCharCode(byte);
    return {
      hash: HASHES[display],
      type: "anim",
      bytes: raw.length,
      data: btoa(binary),
    };
  }));
}

export function preparedBlackElements(generation: number): Element[] {
  return (["back", "front"] as const).map((display) => ({
    id: PREFIX + generation + "-" + display,
    type: "animation",
    display,
    x: 0,
    y: 0,
    z_index: 255,
    opacity: 100,
    assetHash: HASHES[display],
    section: "hold",
    loop: false,
    await_previous_end: false,
  }));
}

/** Logical producer IDs stay stable; every genuine re-entry gets a fresh player. */
export function setPreparedEntryIds(state: State) {
  const item = state.selected ? state.items[state.selected] : undefined;
  state.preparedEntryIds =
    item?.scene.entryLeadMs === 200
      ? Object.fromEntries(
          item.scene.commands[0].elements
            .filter((e) => e.type === "animation" && e.loop !== true)
            .map((e, index) => [
              e.id,
              PREPARED_ENTRY_PREFIX + state.generation + "-" + index,
            ]),
        )
      : {};
}

export function materializePreparedElements(
  state: State,
  elements: Element[],
): Element[] {
  return elements.map((e) =>
    state.preparedEntryIds?.[e.id]
      ? { ...e, id: state.preparedEntryIds[e.id] }
      : e,
  );
}

export function hideObsoleteElement(element: Element): Element {
  if (element.type === "text")
    return {
      ...element,
      text: " ",
      scroll_rate: 0,
      scroll_start_delay: 0,
      scroll_repeat_delay: 0,
    };
  if (["animation", "image", "xpmbitmap"].includes(element.type))
    return { ...element, opacity: 0 };
  // Rectangle/countdown widgets have no opacity property in firmware 1.2.4.
  return { ...element, x: 4095, y: 4095, align: "top_left" };
}
