import type { Snapshot, Service, QueueItem } from "./api";
export function serviceLabel(service: Service) {
  const parts = service.name.split(" · ");
  return parts.length > 1 ? parts.slice(1).join(" · ") : service.name;
}
export function computerIds(service: Service, items: QueueItem[] = []) {
  if (service.computerId) return [service.computerId];
  return [
    ...new Set([
      ...(service.computerIds ?? []),
      ...items
        .filter((i) => i.serviceId === service.id)
        .map((i) => i.instanceId),
    ]),
  ];
}
/** Upgrade a saved presentation preference only when its source maps uniquely. */
export function resolveComputerBinding(
  binding: string | null,
  services: Service[],
  items: QueueItem[] = [],
) {
  if (!binding || services.some((s) => s.computerId === binding))
    return binding;
  const matches = new Set(
    services
      .filter(
        (s) =>
          s.computerId &&
          (s.computerIds?.includes(binding) ||
            items.some(
              (i) => i.serviceId === s.id && i.instanceId === binding,
            )),
      )
      .map((s) => s.computerId!),
  );
  return matches.size === 1 ? [...matches][0] : binding;
}
export function deviceGroups(services: Service[], items: QueueItem[] = []) {
  const groups = new Map<string, Service[]>();
  for (const service of services) {
    const ids = computerIds(service, items);
    for (const id of ids.length ? ids : [`service:${service.id}`])
      groups.set(id, [...(groups.get(id) || []), service]);
  }
  return Array.from(groups, ([name, services]) => ({ name, services }));
}
/** Authoritative server order; presentation never grants ownership. */
export function orderedDeviceGroups(
  snapshot: Pick<Snapshot, "services" | "items" | "computers">,
) {
  return deviceGroups(snapshot.services, snapshot.items)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((group) => {
      const order =
        snapshot.computers?.find((c) => c.id === group.name)?.serviceOrder ??
        [];
      const position = (id: string) => {
        const index = order.indexOf(id);
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
      };
      return {
        ...group,
        services: [...group.services].sort(
          (a, b) => position(a.id) - position(b.id) || a.id.localeCompare(b.id),
        ),
      };
    });
}
