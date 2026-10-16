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
    Number.isFinite(snapshot.serverNow) &&
    Number.isFinite(owner.playback?.startsAt) &&
    snapshot.health.status === "healthy" &&
    snapshot.health.confirmedValidUntil > now &&
    displaying?.generation === snapshot.generation &&
    displaying.confirmedValidUntil > now &&
    owner.playback?.running &&
    owner.playback.validUntil > now
  );
  const item = current ? owner! : representative;
  // Older deployed device instances can briefly omit the additive metadata.
  const {
    totalMs,
    remainingMs: remaining,
    startsAt,
  } = item.playback ?? {
    totalMs: null,
    remainingMs: null,
    startsAt: null,
  };
  const finite = totalMs !== null && totalMs > 0 && remaining !== null;
  // The server's remaining budget already includes playback before serverNow.
  // A future startsAt reserves the entry animation before visible time begins.
  const visibleElapsed =
    startsAt === null
      ? 0
      : Math.max(0, now - Math.max(snapshot.serverNow, startsAt));
  const remainingMs = finite
    ? Math.max(0, remaining - (current ? visibleElapsed : 0))
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
