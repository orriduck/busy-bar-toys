import type { Snapshot, Service } from "./api";
import { priorityGroupOf } from "./priority-groups";
/** Source liveness is local to a registration; device health proves pixels only. */
export function serviceRuntime(snapshot: Snapshot, service: Service) {
  const items = snapshot.items.filter((i) => i.serviceId === service.id);
  const lastHeartbeat =
    service.lastHeartbeatAt ??
    (items.length ? Math.max(...items.map((i) => i.lastHeartbeat)) : null);
  const connection = !service.config.enabled
    ? "Off"
    : lastHeartbeat === null
      ? "Not reported"
      : lastHeartbeat + service.config.heartbeatMs > snapshot.serverNow
        ? "Online"
        : "Offline";
  const current = items.find((i) => i.itemKey === snapshot.selected);
  return {
    connection,
    lastHeartbeat,
    priorityGroup: priorityGroupOf(service),
    queued: items.filter(
      (i) =>
        i.itemKey !== snapshot.selected &&
        i.state !== "paused" &&
        i.state !== "snoozed",
    ).length,
    paused: items.filter((i) => i.state === "paused").length,
    display: current
      ? current.itemKey === snapshot.displaying?.itemKey &&
        snapshot.displaying?.generation === snapshot.generation &&
        snapshot.health.status === "healthy" &&
        snapshot.displaying.confirmedValidUntil > snapshot.serverNow
        ? "Displaying"
        : "Applying"
      : "Idle",
    current: current?.title ?? null,
  };
}
