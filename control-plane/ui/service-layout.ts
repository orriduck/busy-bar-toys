import type { Service, QueueItem } from "./api";
export function serviceLabel(service: Service) {
  const parts = service.name.split(" · ");
  return parts.length > 1 ? parts.slice(1).join(" · ") : service.name;
}
export function computerIds(service: Service, items: QueueItem[] = []) {
  return [
    ...new Set([
      ...(service.computerIds ?? []),
      ...items
        .filter((i) => i.serviceId === service.id)
        .map((i) => i.instanceId),
    ]),
  ];
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
export function priorityOrder(services: Service[]) {
  return [...services].sort(
    (a, b) => b.config.priority - a.config.priority || a.id.localeCompare(b.id),
  );
}
