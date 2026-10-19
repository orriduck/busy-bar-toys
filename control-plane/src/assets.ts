import { State, Slot, requireThat, text } from "./model";
import { digest, unbase64 } from "./security";
export function referencedHashes(s: State) {
  const hashes = new Set<string>(
    Object.values(s.nativeElements)
      .filter((e) => (s.elementExpiries[e.id]?.expiresAt ?? 0) > Date.now())
      .flatMap((e) => (e.assetHash ? [e.assetHash] : [])),
  );
  for (const i of Object.values(s.items))
    for (const c of i.scene.commands)
      for (const e of c.elements) if (e.assetHash) hashes.add(e.assetHash);
  for (const c of s.commands) {
    if (c.hash) hashes.add(c.hash);
    for (const hash of c.preparedAssetHashes ?? []) hashes.add(hash);
    for (const e of c.elements ?? []) if (e.assetHash) hashes.add(e.assetHash);
  }
  return hashes;
}
export function pinnedSlots(s: State) {
  const hashes = new Set<string>(
    Object.values(s.nativeElements)
      .filter((e) => (s.elementExpiries[e.id]?.expiresAt ?? 0) > Date.now())
      .flatMap((e) => (e.assetHash ? [e.assetHash] : [])),
  );
  if (s.displaying && s.items[s.displaying.itemKey])
    for (const c of s.items[s.displaying.itemKey].scene.commands)
      for (const e of c.elements) if (e.assetHash) hashes.add(e.assetHash);
  if (s.selected && s.items[s.selected])
    for (const c of s.items[s.selected].scene.commands)
      for (const e of c.elements) if (e.assetHash) hashes.add(e.assetHash);
  for (const c of s.commands) {
    if (c.hash) hashes.add(c.hash);
    for (const hash of c.preparedAssetHashes ?? []) hashes.add(hash);
    for (const e of c.elements ?? []) if (e.assetHash) hashes.add(e.assetHash);
  }
  return new Set(
    s.slots.filter((slot) => hashes.has(slot.hash)).map((slot) => slot.slot),
  );
}
export async function cacheAsset(
  s: State,
  serviceId: string,
  b: Record<string, unknown>,
  now: number,
) {
  requireThat(typeof b.data === "string");
  requireThat(
    (await digest(unbase64(b.data))) === b.hash,
    "ASSET_HASH_MISMATCH",
  );
  storeAsset(s, serviceId, b, now);
}
export function storeAsset(
  s: State,
  serviceId: string,
  b: Record<string, unknown>,
  now: number,
) {
  const hash = text(b.hash, 64);
  requireThat(/^[a-f0-9]{64}$/.test(hash));
  requireThat(["png", "gif", "webp", "anim"].includes(String(b.type)));
  const data = text(b.data, 350000);
  let bytes: Uint8Array;
  try {
    bytes = unbase64(data);
  } catch {
    requireThat(false, "INVALID_ASSET");
  }
  requireThat(bytes.length > 0 && bytes.length <= 262144, "ASSET_SIZE", 413);
  if (s.assets[hash]) {
    requireThat(s.assets[hash].type === b.type, "ASSET_TYPE_CONFLICT", 409);
    if (!s.assets[hash].owners.includes(serviceId))
      s.assets[hash].owners.push(serviceId);
    s.assets[hash].usedAt = now;
    return;
  }
  const pinned = referencedHashes(s);
  while (
    Object.keys(s.assets).length >= 64 ||
    Object.values(s.assets).reduce((n, a) => n + a.bytes, 0) + bytes.length >
      4 * 1024 * 1024
  ) {
    const evict = Object.values(s.assets)
      .filter((a) => !pinned.has(a.hash))
      .sort((a, b) => a.usedAt - b.usedAt)[0];
    requireThat(evict, "ASSET_CACHE_CAPACITY", 413);
    delete s.assets[evict.hash];
  }
  s.assets[hash] = {
    hash,
    type: String(b.type),
    data,
    bytes: bytes.length,
    owners: [serviceId],
    usedAt: now,
  };
  s.revision++;
}
export function reserveSlots(
  s: State,
  hashes: string[],
  pins: Set<number>,
  now: number,
): Slot[] {
  const reserved = new Set(pins),
    result: Slot[] = [];
  for (const hash of new Set(hashes)) {
    const asset = s.assets[hash];
    requireThat(asset, "ASSET_MISSING", 409);
    let slot = s.slots.find((slot) => slot.hash === hash);
    if (!slot) {
      const index =
        Array.from({ length: 16 }, (_, i) => i).find(
          (i) => !reserved.has(i) && !s.slots.some((slot) => slot.slot === i),
        ) ??
        s.slots.find(
          (slot) => !reserved.has(slot.slot) && slot.type === asset.type,
        )?.slot;
      requireThat(index !== undefined, "SLOT_CAPACITY", 413);
      const otherBytes = s.slots
        .filter((slot) => slot.slot !== index)
        .reduce((n, slot) => n + slot.bytes, 0);
      requireThat(
        otherBytes + asset.bytes <= 2 * 1024 * 1024,
        "SLOT_BYTES_CAPACITY",
        413,
      );
      slot = {
        slot: index,
        hash,
        type: asset.type,
        bytes: asset.bytes,
        uploaded: false,
      };
      s.slots = s.slots.filter((slot) => slot.slot !== index);
      s.slots.push(slot);
    }
    reserved.add(slot.slot);
    asset.usedAt = now;
    result.push(slot);
  }
  return result;
}
