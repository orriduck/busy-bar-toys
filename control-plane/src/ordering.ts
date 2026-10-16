import type { State, Item } from "./model";

/** Legacy numbers seed an explicit order once. Empty hashes are unclaimed groups,
 * never credentials. Keep peer registrations visible before their Mac upgrades. */
export function migrateServiceOrders(s: State, now: number) {
  let changed = false;
  const ids = [
    ...new Set(
      Object.values(s.services)
        .map((service) => service.computerId)
        .filter((id): id is string => !!id),
    ),
  ];
  for (const id of ids) {
    if (Object.hasOwn(s.computers, id)) continue;
    s.computers[id] = {
      id,
      credentialHash: "",
      createdAt: now,
      serviceOrder: Object.values(s.services)
        .filter((service) => service.computerId === id)
        .sort(
          (a, b) =>
            b.config.priority - a.config.priority || a.id.localeCompare(b.id),
        )
        .map((service) => service.id),
    };
    changed = true;
  }
  if (changed) s.revision++;
  return changed;
}
export function servicePosition(s: State, id: string) {
  const computer = s.services[id]?.computerId;
  const index = computer
    ? (s.computers[computer]?.serviceOrder.indexOf(id) ?? -1)
    : -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}
export function computerOf(s: State, item: Item) {
  return s.services[item.serviceId]?.computerId ?? item.serviceId;
}
/** Round-robin across ready computers, retaining the active normal computer until
 * its source ends or finite playback completes. No time slicing of source leases. */
export function normalOrder<T extends { representative: Item }>(
  s: State,
  groups: T[],
) {
  const by = new Map<string, T[]>();
  for (const group of groups) {
    const id = computerOf(s, group.representative);
    by.set(id, [...(by.get(id) ?? []), group]);
  }
  for (const group of by.values())
    group.sort(
      (a, b) =>
        servicePosition(s, a.representative.serviceId) -
          servicePosition(s, b.representative.serviceId) ||
        (a.representative.serviceId === b.representative.serviceId
          ? 0
          : a.representative.serviceId.localeCompare(
              b.representative.serviceId,
            )) ||
        a.representative.receivedAt - b.representative.receivedAt ||
        a.representative.enqueueSeq - b.representative.enqueueSeq,
    );
  const ids = [...by.keys()].sort();
  const last = s.lastNormalComputer;
  const next = last ? ids.findIndex((id) => id > last) : 0;
  const start = next < 0 ? 0 : next;
  const order = [...ids.slice(start), ...ids.slice(0, start)];
  const lease = s.normalLeaseItem ? s.items[s.normalLeaseItem] : null;
  const active =
    lease &&
    groups.some((g) => g.representative.serviceId === lease.serviceId) &&
    lease.state !== "paused" &&
    lease.state !== "snoozed"
      ? lease
      : s.selected
        ? s.items[s.selected]
        : null;
  if (
    active &&
    active.level !== "urgent" &&
    groups.some((g) => g.representative.serviceId === active.serviceId)
  ) {
    const id = computerOf(s, active),
      index = order.indexOf(id);
    if (index >= 0) order.unshift(...order.splice(index, 1));
  }
  const result: T[] = [];
  // An overlay resumes the retained source before another computer. Reflect
  // that continuation in queue order and ETA as well as the next selection.
  if (active && active.level !== "urgent") {
    const own = by.get(computerOf(s, active));
    const leaseIndex =
      own?.findIndex((g) => g.representative.serviceId === active.serviceId) ??
      -1;
    if (own && leaseIndex > 0) result.push(...own.splice(0, leaseIndex));
  }
  for (let index = 0; index < groups.length; index++)
    for (const id of order) {
      const group = by.get(id)?.[index];
      if (group) result.push(group);
    }
  return result;
}
