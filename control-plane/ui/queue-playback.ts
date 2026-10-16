import type { QueueItem, Snapshot } from "./api";

/** Elapsed time is monotonic and starts when this snapshot reaches the UI. */
export function queuePlayback(
  snapshot: Snapshot,
  memberKeys: string[],
  representative: QueueItem,
  elapsedMs: number,
) {
  const elapsed = Math.max(0, elapsedMs);
  const now = snapshot.serverNow + elapsed;
  const displaying = snapshot.displaying;
  const owner =
    displaying && memberKeys.includes(displaying.itemKey)
      ? snapshot.items.find((item) => item.itemKey === displaying.itemKey)
      : undefined;
  const current = !!(
    owner &&
    snapshot.health.status === "healthy" &&
    snapshot.health.confirmedValidUntil > now &&
    displaying?.generation === snapshot.generation &&
    displaying.confirmedValidUntil > now &&
    owner.playback.running &&
    owner.playback.validUntil > now
  );
  const item = current ? owner! : representative;
  const { totalMs, remainingMs: remaining } = item.playback;
  const finite = totalMs !== null && totalMs > 0 && remaining !== null;
  const remainingMs = finite
    ? Math.max(0, remaining - (current ? elapsed : 0))
    : null;
  return {
    item,
    current,
    priority: snapshot.services.find((service) => service.id === item.serviceId)
      ?.config.priority,
    remainingMs,
    progress:
      current && finite
        ? Math.min(100, Math.max(0, ((totalMs - remainingMs!) / totalMs) * 100))
        : null,
  };
}

export function receivedTime(receivedAt: number) {
  return new Date(receivedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
