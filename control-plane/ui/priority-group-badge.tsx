import { Badge } from "./components/ui/badge";
import {
  priorityGroupDescriptions,
  priorityGroupLabels,
  type PriorityGroup,
} from "./priority-groups";
export function PriorityGroupBadge({ group }: { group: PriorityGroup }) {
  return (
    <Badge
      variant="outline"
      className="priority-group-badge"
      data-priority-group={group}
      title={priorityGroupDescriptions[group]}
    >
      <span className="priority-group-dot" aria-hidden="true" />
      <span>{priorityGroupLabels[group]}</span>
    </Badge>
  );
}
