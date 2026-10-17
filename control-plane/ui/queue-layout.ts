import type { Snapshot } from "./api";
import { queueMetadata } from "./queue-metadata";
import { queuePlayback } from "./queue-playback";
import { priorityGroupOf } from "./priority-groups";

/** Presentation only: the server owns order, turns and proof of playback. */
export function queueLayout(snapshot: Snapshot, elapsed = 0) {
  const groups = snapshot.groups.flatMap((group) => {
    const item = snapshot.items.find((i) => i.itemKey === group.representative);
    return item ? [{ ...group, representativeItem: item }] : [];
  });
  const represented = new Set(groups.flatMap((g) => g.memberKeys));
  const orphaned = snapshot.items
    .filter((i) => !represented.has(i.itemKey))
    .map((item) => ({
      groupId: item.itemKey,
      memberKeys: [item.itemKey],
      representativeItem: item,
    }));
  const rotatingServices = new Set(
    snapshot.items
      .filter((item) => {
        const service = snapshot.services.find((s) => s.id === item.serviceId);
        return (
          service?.config.enabled &&
          priorityGroupOf(service) === "dispensable" &&
          item.state !== "paused" &&
          item.state !== "snoozed"
        );
      })
      .map((i) => i.serviceId),
  );
  return [...groups, ...orphaned]
    .map((group) => {
      const playback = queuePlayback(
        snapshot,
        group.memberKeys,
        group.representativeItem,
        elapsed,
      );
      const eligible =
        playback.item.state !== "paused" && playback.item.state !== "snoozed";
      return {
        groupId: group.groupId,
        memberKeys: group.memberKeys,
        ...playback,
        meta: queueMetadata(playback.item, snapshot),
        rotating:
          eligible &&
          rotatingServices.size > 1 &&
          rotatingServices.has(playback.item.serviceId),
        applying:
          !playback.current &&
          group.memberKeys.includes(snapshot.applying ?? ""),
      };
    })
    .sort((a, b) => Number(b.current) - Number(a.current));
}

export type QueueRow = ReturnType<typeof queueLayout>[number];
/** queueLayout leads with the confirmed owner. Keep that occurrence when a
 * service has several messages, rather than letting a waiting one replace it. */
export function rotationServices(rows: QueueRow[]) {
  const services = new Map<string, QueueRow>();
  for (const row of rows)
    if (row.rotating && !services.has(row.item.serviceId))
      services.set(row.item.serviceId, row);
  return [...services.values()];
}
export type PresenceEntry<T> = { id: string; value: T; until: number | null };
export const queueExitMs = 240;

/** Bounded, inert visual departures. Reappearance cancels an exit immediately. */
export function queuePresence<T>(
  previous: PresenceEntry<T>[],
  latest: { id: string; value: T }[],
  now: number,
  animate: boolean,
): PresenceEntry<T>[] {
  const next: PresenceEntry<T>[] = latest.map((row) => ({
    ...row,
    until: null,
  }));
  if (!animate) return next;
  const live = new Set(latest.map((row) => row.id));
  let departures = 0;
  for (let index = 0; index < previous.length; index++) {
    const row = previous[index];
    if (
      live.has(row.id) ||
      (row.until !== null && row.until <= now) ||
      departures >= 12
    )
      continue;
    next.splice(Math.min(index, next.length), 0, {
      ...row,
      until: row.until ?? now + queueExitMs,
    });
    departures++;
  }
  return next;
}
