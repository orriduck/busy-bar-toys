import type { State } from "./model";

/** One-time upgrade of declared legacy groups. These IDs are not hardware proof.
 * Publisher instance IDs and queue keys remain unchanged. Never infer groups for
 * newly registered services: their computer is an explicit management choice.
 */
export function migrateComputerIds(
  state: State,
  newId: () => string = () => crypto.randomUUID(),
) {
  const services = Object.values(state.services);
  if (services.every((s) => s.computerId)) return false;
  const parent = services.map((_, i) => i);
  const root = (i: number): number =>
    parent[i] === i ? i : (parent[i] = root(parent[i]));
  const seen = new Map<string, number>();
  services.forEach((service, i) => {
    const prefix = service.name.includes(" · ")
      ? service.name.split(" · ")[0].trim()
      : "";
    const sources = [
      ...(service.computerIds ?? []),
      ...Object.values(state.items)
        .filter((item) => item.serviceId === service.id)
        .map((item) => item.instanceId),
    ];
    const keys = [
      ...(prefix ? [`label:${prefix}`] : []),
      ...sources.map((id) => `source:${id}`),
    ];
    for (const key of keys) {
      const other = seen.get(key);
      if (other !== undefined) parent[root(i)] = root(other);
      seen.set(key, i);
    }
  });
  const ids = new Map<number, string>();
  // Preserve any already persisted identities in a partially upgraded state.
  services.forEach((s, i) => {
    if (s.computerId && !ids.has(root(i))) ids.set(root(i), s.computerId);
  });
  services.forEach((s, i) => {
    if (s.computerId) return;
    const group = root(i);
    if (!ids.has(group)) ids.set(group, newId());
    s.computerId = ids.get(group)!;
  });
  state.configRevision++;
  state.revision++;
  return true;
}
