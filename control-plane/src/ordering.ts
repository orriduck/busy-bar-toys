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
/** A turn belongs to a service, not a message or publisher instance. */
export function prepareTurns(s: State) {
  s.serviceTurns ??= {};
  s.turnSeq ??= 0;
  const live = new Set(
    Object.values(s.items)
      .filter((i) => i.level !== "urgent")
      .map((i) => i.serviceId),
  );
  for (const id of Object.keys(s.serviceTurns))
    if (!live.has(id)) delete s.serviceTurns[id];
  const items = Object.values(s.items)
    .filter((i) => i.level !== "urgent")
    .sort((a, b) => a.enqueueSeq - b.enqueueSeq);
  for (const item of items)
    if (!s.serviceTurns[item.serviceId]) {
      const totalMs = s.services[item.serviceId].config.visibleMs;
      s.serviceTurns[item.serviceId] = {
        totalMs,
        remainingMs: totalMs,
        ticket: ++s.turnSeq,
      };
    }
}
export function hasTurnPeer(s: State, item: Item) {
  return (
    item.level !== "urgent" &&
    Object.values(s.items).some(
      (i) =>
        i.serviceId !== item.serviceId &&
        i.level !== "urgent" &&
        i.state !== "paused" &&
        i.state !== "snoozed" &&
        servicePosition(s, i.serviceId) === servicePosition(s, item.serviceId),
    )
  );
}
export function yieldTurn(s: State, id: string) {
  const totalMs = s.services[id].config.visibleMs;
  s.serviceTurns[id] = { totalMs, remainingMs: totalMs, ticket: ++s.turnSeq };
  s.revision++;
}
/** Position is a global tier; equal-tier services rotate by persisted FIFO turn. */
export function normalOrder<T extends { representative: Item }>(
  s: State,
  groups: T[],
) {
  const by = new Map<string, T[]>();
  const active = s.selected ? s.items[s.selected] : null;
  const activeGroup = (i: Item) =>
    !!active &&
    i.serviceId === active.serviceId &&
    (i.groupKey !== undefined
      ? i.groupKey === active.groupKey
      : i.itemKey === active.itemKey);
  for (const g of groups)
    by.set(g.representative.serviceId, [
      ...(by.get(g.representative.serviceId) ?? []),
      g,
    ]);
  const round = new Map<T, number>();
  for (const own of by.values()) {
    own.sort(
      (a, b) =>
        Number(activeGroup(b.representative)) -
          Number(activeGroup(a.representative)) ||
        a.representative.enqueueSeq - b.representative.enqueueSeq,
    );
    own.forEach((g, index) => round.set(g, index));
  }
  return [...groups].sort((a, b) => {
    const x = a.representative,
      y = b.representative;
    return (
      servicePosition(s, x.serviceId) - servicePosition(s, y.serviceId) ||
      round.get(a)! - round.get(b)! ||
      (s.serviceTurns?.[x.serviceId]?.ticket ?? x.enqueueSeq) -
        (s.serviceTurns?.[y.serviceId]?.ticket ?? y.enqueueSeq) ||
      x.receivedAt - y.receivedAt ||
      x.enqueueSeq - y.enqueueSeq
    );
  });
}
