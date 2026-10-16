import type { State } from "./model";

/** Owner-approved retirement, 2026-10-16 (issue #35).
 * An exact deployment migration, not a device-token or cross-computer API grant.
 * Any evidence of renewed ownership, publishing, work or actions stops the pair.
 */
export function retireApprovedLegacyRegistrations(s: State) {
  const computerId = "a41eb50e-7dda-427a-8ed2-d72e0e14104a";
  const ids = ["macbook-agent", "macbook-notifier"];
  const computer = s.computers[computerId];
  if (!computer || computer.credentialHash) return false;
  const services = ids.flatMap((id) =>
    s.services[id] ? [s.services[id]] : [],
  );
  if (
    !services.length ||
    services.some(
      (service) =>
        service.computerId !== computerId ||
        service.lastHeartbeatAt !== undefined,
    )
  )
    return false;
  if (
    Object.values(s.services).some(
      (service) =>
        service.computerId === computerId && !ids.includes(service.id),
    )
  )
    return false;
  if (Object.values(s.items).some((item) => ids.includes(item.serviceId)))
    return false;
  if (
    Object.values(s.actions).some(
      (action) =>
        ids.includes(action.serviceId) &&
        ["pending", "running", "unknown"].includes(action.status),
    )
  )
    return false;
  for (const id of ids) {
    delete s.services[id];
    delete s.serviceTurns[id];
  }
  delete s.computers[computerId];
  s.configRevision++;
  s.revision++;
  return true;
}
