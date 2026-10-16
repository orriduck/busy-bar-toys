import {
  PRIORITY_GROUPS,
  priorityGroupOf,
  type PriorityGroup,
} from "../src/priority-groups";
import type { Snapshot } from "./api";
import { orderedDeviceGroups } from "./service-layout";
export { PRIORITY_GROUPS, priorityGroupOf, type PriorityGroup };
export type OwnedPriorityGroups = Record<PriorityGroup, string[]>;
export const priorityGroupLabels: Record<PriorityGroup, string> = {
  interception: "Interception",
  "follow-queue": "Follow queue",
  dispensable: "Dispensable",
};
export const priorityGroupDescriptions: Record<PriorityGroup, string> = {
  interception:
    "Equal services. Interrupts lower groups; stays until completed.",
  "follow-queue":
    "Equal services in arrival order. Resumes after interruptions.",
  dispensable:
    "Equal services take turns by Hold, including this computer’s services.",
};
const emptyGroups = (): OwnedPriorityGroups => ({
  interception: [],
  "follow-queue": [],
  dispensable: [],
});
type OrderedSnapshot = Pick<Snapshot, "services" | "items" | "computers">;
export function ownedPriorityGroups(
  snapshot: OrderedSnapshot,
  ownerComputerId: string | null,
): OwnedPriorityGroups {
  const result = emptyGroups();
  if (!ownerComputerId) return result;
  const own = orderedDeviceGroups(snapshot).find(
    (computer) => computer.name === ownerComputerId,
  );
  for (const service of own?.services ?? [])
    if (service.computerId === ownerComputerId)
      result[priorityGroupOf(service)].push(service.id);
  return result;
}
/** All computers retain their authoritative block and order; drafts affect only the owner. */
export function globalPriorityGroups(
  snapshot: OrderedSnapshot,
  ownerComputerId: string | null,
  draft?: OwnedPriorityGroups | null,
) {
  const computers = orderedDeviceGroups(snapshot);
  return PRIORITY_GROUPS.map((id) => ({
    id,
    services: computers.flatMap((computer) => {
      if (draft && computer.name === ownerComputerId)
        return draft[id].flatMap((serviceId) => {
          const service = computer.services.find((s) => s.id === serviceId);
          return service ? [service] : [];
        });
      return computer.services.filter(
        (service) => priorityGroupOf(service) === id,
      );
    }),
  }));
}
/** Complete own-service permutation: foreign sources or targets cannot change any queue. */
export function moveOwnedService(
  groups: OwnedPriorityGroups,
  serviceId: string,
  targetGroup: PriorityGroup,
  targetId?: string,
): OwnedPriorityGroups {
  const sourceGroup = PRIORITY_GROUPS.find((group) =>
    groups[group].includes(serviceId),
  );
  if (
    !sourceGroup ||
    (targetId && !groups[targetGroup].includes(targetId)) ||
    targetId === serviceId
  )
    return groups;
  if (sourceGroup === targetGroup) return groups;
  const next = Object.fromEntries(
    PRIORITY_GROUPS.map((group) => [
      group,
      groups[group].filter((id) => id !== serviceId),
    ]),
  ) as OwnedPriorityGroups;
  next[targetGroup].push(serviceId);
  return next;
}
