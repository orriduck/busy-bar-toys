import { PRIORITY_GROUPS, priorityGroupOf } from "./priority-groups";
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
export function computerOf(s: State, item: Item) {
  return s.services[item.serviceId]?.computerId ?? item.serviceId;
}
/** A turn belongs to a service, not a message or publisher instance. */
export function prepareTurns(s: State) {
  s.turnSeq ??= 0;
  s.priorityComputerTurns ??= {};
  s.priorityLeases ??= {};
  const eligible = Object.values(s.items)
    .filter((i) => i.state !== "paused" && i.state !== "snoozed")
    .sort((a, b) => a.enqueueSeq - b.enqueueSeq);
  for (const group of PRIORITY_GROUPS) {
    const lease = s.priorityLeases[group];
    if (
      lease &&
      !eligible.some(
        (i) =>
          i.itemKey === lease &&
          priorityGroupOf(s.services[i.serviceId]) === group,
      )
    )
      delete s.priorityLeases[group];
  }
  s.serviceTurns ??= {};
  const live = new Set(
    Object.values(s.items)
      .filter((i) => priorityGroupOf(s.services[i.serviceId]) === "dispensable")
      .map((i) => i.serviceId),
  );
  for (const id of Object.keys(s.serviceTurns))
    if (!live.has(id)) delete s.serviceTurns[id];
  const items = Object.values(s.items)
    .filter((i) => priorityGroupOf(s.services[i.serviceId]) === "dispensable")
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
    priorityGroupOf(s.services[item.serviceId]) === "dispensable" &&
    Object.values(s.items).some(
      (i) =>
        i.serviceId !== item.serviceId &&
        priorityGroupOf(s.services[i.serviceId]) === "dispensable" &&
        i.state !== "paused" &&
        i.state !== "snoozed",
    )
  );
}
export function yieldTurn(s: State, id: string) {
  const totalMs = s.services[id].config.visibleMs;
  s.serviceTurns[id] = { totalMs, remainingMs: totalMs, ticket: ++s.turnSeq };
  s.revision++;
}
/** Legacy name retained internally; only release this occurrence's group lease. */
export function yieldComputer(s: State, item: Item) {
  s.priorityLeases ??= {};
  const group = priorityGroupOf(s.services[item.serviceId]);
  if (s.priorityLeases[group] === item.itemKey) delete s.priorityLeases[group];
  s.revision++;
}
/** Completion groups retain their occurrence lease across interruptions, then
 * use global FIFO. Dispensable services share global Hold tickets, regardless of
 * computer; later messages from one service wait for the next service round. */
export function normalOrder<
  T extends { representative: Item; members: Item[] },
>(s: State, groups: T[]): T[] {
  return PRIORITY_GROUPS.flatMap((group) => {
    const lease = s.priorityLeases[group];
    const eligible = groups.filter(
      (g) => priorityGroupOf(s.services[g.representative.serviceId]) === group,
    );
    // Display severity may select a later representative. The bundle's place
    // belongs to its first eligible occurrence, independent of display content.
    const arrival = (g: T) => Math.min(...g.members.map((i) => i.enqueueSeq));
    const fifo = (a: T, b: T) => arrival(a) - arrival(b);
    if (group !== "dispensable")
      return eligible.sort(
        (a, b) =>
          Number(b.representative.itemKey === lease) -
            Number(a.representative.itemKey === lease) || fifo(a, b),
      );
    const leasedService = eligible.find(
      (g) => g.representative.itemKey === lease,
    )?.representative.serviceId;
    const hasBudget =
      !!leasedService && s.serviceTurns[leasedService]?.remainingMs > 0;
    const byService = new Map<string, T[]>();
    for (const item of eligible.sort(
      (a, b) =>
        Number(hasBudget && b.representative.itemKey === lease) -
          Number(hasBudget && a.representative.itemKey === lease) || fifo(a, b),
    )) {
      const id = item.representative.serviceId;
      byService.set(id, [...(byService.get(id) ?? []), item]);
    }
    const services = [...byService].sort(
      ([a, xs], [b, ys]) =>
        Number(hasBudget && b === leasedService) -
          Number(hasBudget && a === leasedService) ||
        (s.serviceTurns[a]?.ticket ?? Number.MAX_SAFE_INTEGER) -
          (s.serviceTurns[b]?.ticket ?? Number.MAX_SAFE_INTEGER) ||
        fifo(xs[0], ys[0]),
    );
    const result: T[] = [];
    while (services.some(([, own]) => own.length))
      for (const [, own] of services) {
        const next = own.shift();
        if (next) result.push(next);
      }
    return result;
  });
}
