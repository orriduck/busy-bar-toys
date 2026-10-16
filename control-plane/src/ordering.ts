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
  s.turnSeq ??= 0;
  s.priorityComputerTurns ??= {};
  s.priorityLeases ??= {};
  const eligible = Object.values(s.items)
    .filter((i) => i.state !== "paused" && i.state !== "snoozed")
    .sort((a, b) => a.enqueueSeq - b.enqueueSeq);
  const liveComputers = new Set(eligible.map((i) => computerKey(s, i)));
  for (const key of Object.keys(s.priorityComputerTurns))
    if (!liveComputers.has(key)) delete s.priorityComputerTurns[key];
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
  for (const i of eligible) {
    const key = computerKey(s, i);
    s.priorityComputerTurns[key] ??= ++s.turnSeq;
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
        computerOf(s, i) !== computerOf(s, item) &&
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
const computerKey = (s: State, item: Item) =>
  JSON.stringify([
    priorityGroupOf(s.services[item.serviceId]),
    computerOf(s, item),
  ]);
export function yieldComputer(s: State, item: Item) {
  s.priorityComputerTurns ??= {};
  s.priorityLeases ??= {};
  s.priorityComputerTurns[computerKey(s, item)] = ++s.turnSeq;
  delete s.priorityLeases[priorityGroupOf(s.services[item.serviceId])];
  s.revision++;
}
/** Global group, fair computer, that computer's ordered service head. The two
 * completion groups retain their occurrence lease across higher interruptions. */
export function normalOrder<T extends { representative: Item }>(
  s: State,
  groups: T[],
): T[] {
  const result: T[] = [];
  for (const group of PRIORITY_GROUPS) {
    const byComputer = new Map<string, T[]>();
    const lease = s.priorityLeases[group];
    for (const g of groups.filter(
      (g) => priorityGroupOf(s.services[g.representative.serviceId]) === group,
    )) {
      const key = computerKey(s, g.representative);
      byComputer.set(key, [...(byComputer.get(key) ?? []), g]);
    }
    for (const own of byComputer.values())
      own.sort(
        (a, b) =>
          (group === "dispensable"
            ? 0
            : Number(b.representative.itemKey === lease) -
              Number(a.representative.itemKey === lease)) ||
          servicePosition(s, a.representative.serviceId) -
            servicePosition(s, b.representative.serviceId) ||
          Number(b.representative.itemKey === lease) -
            Number(a.representative.itemKey === lease) ||
          a.representative.enqueueSeq - b.representative.enqueueSeq,
      );
    const computers = [...byComputer].sort(
      ([a, xs], [b, ys]) =>
        (group === "dispensable"
          ? 0
          : Number(ys.some((g) => g.representative.itemKey === lease)) -
            Number(xs.some((g) => g.representative.itemKey === lease))) ||
        s.priorityComputerTurns[a] - s.priorityComputerTurns[b] ||
        a.localeCompare(b),
    );
    // One occurrence from each computer per round; later own messages cannot
    // jump past that computer's service head on the next scheduling boundary.
    while (computers.some(([, own]) => own.length))
      for (const [, own] of computers) {
        const next = own.shift();
        if (next) result.push(next);
      }
  }
  return result;
}
