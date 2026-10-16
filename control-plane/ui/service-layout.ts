import type { Service } from "./api";
/** Device labels are explicitly registered name prefixes, never inferred host identity. */
export function serviceLabel(service: Service) {
  const parts = service.name.split(" · ");
  return parts.length > 1 ? parts.slice(1).join(" · ") : service.name;
}
export function deviceGroups(services: Service[]) {
  const groups = new Map<string, Service[]>();
  for (const service of services) {
    const parts = service.name.split(" · ");
    const label =
      parts.length > 1 && parts[0].trim() ? parts[0].trim() : "Ungrouped";
    groups.set(label, [...(groups.get(label) || []), service]);
  }
  return Array.from(groups, ([name, services]) => ({ name, services }));
}
export function priorityOrder(services: Service[]) {
  return [...services].sort(
    (a, b) => b.config.priority - a.config.priority || a.id.localeCompare(b.id),
  );
}
