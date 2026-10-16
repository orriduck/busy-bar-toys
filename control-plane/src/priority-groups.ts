import type { Service, State } from "./model";
export const PRIORITY_GROUPS = [
  "interception",
  "follow-queue",
  "dispensable",
] as const;
export type PriorityGroup = (typeof PRIORITY_GROUPS)[number];
export const PRIORITY_GROUP_LABELS: Record<PriorityGroup, string> = {
  interception: "Interception",
  "follow-queue": "Follow queue",
  dispensable: "Dispensable",
};
export function priorityGroupOf(
  service: Pick<Service, "template" | "priorityGroup">,
): PriorityGroup {
  return (
    service.priorityGroup ??
    (service.template === "agent" ? "dispensable" : "follow-queue")
  );
}
const LEGACY_GROUP_ASSIGNMENTS: readonly [string, string, PriorityGroup][] = [
  [
    "17e03307-7374-4021-a7ae-58c165ba8d6e",
    "c2903b6c-d5d7-4471-b388-469223a77a78",
    "interception",
  ],
  [
    "565505c4-4c29-4d24-82e0-f97d1659156c",
    "c2903b6c-d5d7-4471-b388-469223a77a78",
    "dispensable",
  ],
  [
    "bf0706b2-6ffc-4996-9454-61740d92c7b8",
    "2199977f-a93e-40b1-9c25-3ebc95fa524d",
    "dispensable",
  ],
];
/** Only absent fields are migrated; subsequent user choices survive restarts. */
export function migratePriorityGroups(s: State) {
  let changed = false;
  for (const service of Object.values(s.services)) {
    if (service.priorityGroup !== undefined) continue;
    service.priorityGroup =
      LEGACY_GROUP_ASSIGNMENTS.find(
        ([id, computerId]) =>
          service.id === id && service.computerId === computerId,
      )?.[2] ?? "follow-queue";
    if (s.selected && s.items[s.selected]?.serviceId === service.id) {
      s.priorityLeases ??= {};
      for (const group of PRIORITY_GROUPS)
        if (s.priorityLeases[group] === s.selected)
          delete s.priorityLeases[group];
      s.priorityLeases[service.priorityGroup] = s.selected;
    }
    changed = true;
  }
  if (changed) {
    s.configRevision++;
    s.revision++;
  }
  return changed;
}
