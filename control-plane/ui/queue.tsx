import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { etaText, queueMetadata } from "./api";
import { priorityGroupLabels } from "./priority-groups";
import { compactSender } from "./queue-metadata";
import { ChevronDown } from "lucide-react";
import { PriorityGroupBadge } from "./priority-group-badge";
import type { Snapshot, QueueItem, Mutate } from "./api";
import { AppIcon, Icon } from "./common";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Progress } from "./components/ui/progress";
import { Empty, EmptyHeader, EmptyTitle } from "./components/ui/empty";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./components/ui/table";
import { cn } from "./lib/utils";
import { queuePlayback, receivedTime } from "./queue-playback";
import { useListMotion } from "./motion";
import { Collapsible, CollapsibleContent } from "./components/ui/collapsible";

type QueueRow = {
  groupId: string;
  memberKeys: string[];
  item: QueueItem;
  meta: ReturnType<typeof queueMetadata>;
  open: boolean;
  current: boolean;
  progress: number | null;
  toggle: (id: string) => void;
};
const features = tableFeatures({});
const column = createColumnHelper<typeof features, QueueRow>();
const columns = column.columns([
  column.accessor((row) => row.meta.app, {
    id: "app",
    header: "App",
    cell: ({ row }) => {
      const { groupId, meta, open, toggle, current, progress } = row.original;
      return (
        <div className="queue-app-cell">
          <Button
            variant="disclosure"
            className="queue-open"
            aria-expanded={open}
            aria-controls={`details-${encodeURIComponent(groupId)}`}
            aria-label={`${open ? "Hide" : "Show"} ${meta.app} details from ${meta.sender}${meta.priorityGroup ? `, ${priorityGroupLabels[meta.priorityGroup]} priority` : ""}${current ? ", playing" : ""}`}
            onClick={() => toggle(groupId)}
          >
            <span className="queue-app-icon">
              <AppIcon app={meta.appId} />
            </span>
            <span className="queue-app-copy">
              <span className="queue-app-name">
                <span>{meta.app}</span>
                {current && (
                  <span className="queue-live-dot" aria-label="Playing" />
                )}
              </span>
              {meta.priorityGroup && (
                <PriorityGroupBadge group={meta.priorityGroup} />
              )}
            </span>
            <ChevronDown className="queue-disclosure" aria-hidden="true" />
          </Button>
          {current && (
            <Progress
              className="queue-playback-line"
              data-size="thin"
              value={progress === null ? null : Math.round(progress)}
              aria-label={`${meta.app} playback`}
              aria-valuetext={
                progress === null ? "Playing · duration unknown" : undefined
              }
            />
          )}
        </div>
      );
    },
  }),
  column.accessor((row) => row.meta.sender, {
    id: "sender",
    header: "Sender",
    cell: ({ row }) => {
      const { meta, item } = row.original;
      const [computer, ...parts] = compactSender(meta.sender).split(" · ");
      const service = parts.join(" · ");
      const normalize = (value: string) =>
        value.toLowerCase().replace(/\s+code$/, "");
      const distinctService =
        service && normalize(service) !== normalize(meta.app);
      return (
        <span
          className="sender"
          title={`${meta.sender} · source ${item.instanceId}`}
        >
          <span className="queue-computer">{computer}</span>
          {distinctService && (
            <span className="queue-source-service">{service}</span>
          )}
        </span>
      );
    },
  }),
  column.accessor((row) => row.meta.receivedAt, {
    id: "received",
    header: "Received",
    cell: ({ row }) => {
      const date = new Date(row.original.meta.receivedAt);
      return (
        <time dateTime={date.toISOString()} title={date.toLocaleString()}>
          {receivedTime(row.original.meta.receivedAt)}
        </time>
      );
    },
  }),
]);
export function Queue({
  snapshot,
  mutate,
  pending,
  ownerComputerId,
}: {
  ownerComputerId: string | null;
  snapshot: Snapshot;
  mutate: Mutate;
  pending: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const anchor = useMemo(() => performance.now(), [snapshot]);
  const [monotonicNow, setMonotonicNow] = useState(anchor);
  useEffect(() => {
    const update = () => setMonotonicNow(performance.now());
    update();
    const owner = snapshot.items.find(
      (item) => item.itemKey === snapshot.displaying?.itemKey,
    );
    if (!owner?.playback?.running || !Number.isFinite(snapshot.serverNow))
      return;
    const validUntil = Math.min(
      owner.playback.validUntil,
      snapshot.health.confirmedValidUntil,
      snapshot.displaying!.confirmedValidUntil,
    );
    if (validUntil <= snapshot.serverNow) return;
    const timer = window.setInterval(() => {
      update();
      if (performance.now() - anchor >= validUntil - snapshot.serverNow)
        window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [snapshot, anchor]);
  const elapsed = Math.max(0, monotonicNow - anchor);
  const toggle = useCallback(
    (id: string) =>
      setExpanded((previous) => {
        const next = new Set(previous);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      }),
    [],
  );
  const data = useMemo(() => {
    const groups = snapshot.groups
      .map((group) => ({
        ...group,
        representativeItem: snapshot.items.find(
          (item) => item.itemKey === group.representative,
        ),
      }))
      .filter((group) => group.representativeItem);
    const represented = new Set(groups.flatMap((group) => group.memberKeys));
    const orphaned = snapshot.items
      .filter((item) => !represented.has(item.itemKey))
      .map((item) => ({
        groupId: item.itemKey,
        memberKeys: [item.itemKey],
        representativeItem: item,
      }));
    return [...groups, ...orphaned].map((group): QueueRow => {
      const playback = queuePlayback(
        snapshot,
        group.memberKeys,
        group.representativeItem!,
        elapsed,
      );
      return {
        groupId: group.groupId,
        memberKeys: group.memberKeys,
        item: playback.item,
        meta: queueMetadata(playback.item, snapshot),
        open: expanded.has(group.groupId),
        current: playback.current,
        progress: playback.progress,
        toggle,
      };
    });
  }, [snapshot, expanded, toggle, elapsed]);
  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => row.groupId,
  });
  const scope = useRef<HTMLDivElement>(null);
  const structure = JSON.stringify(
    data.map((group) => [group.groupId, group.open]),
  );
  useListMotion(scope, structure);
  const operate = (item: QueueItem, operation: string) =>
    void mutate("/items", {
      itemKey: item.itemKey,
      operation,
      expectedRevision: snapshot.revision,
    });
  const details = (item: QueueItem) => {
    const meta = queueMetadata(item, snapshot);
    const readOnly =
      snapshot.services.find((s) => s.id === item.serviceId)?.computerId !==
        ownerComputerId || !ownerComputerId;
    return (
      <section
        className="item-detail"
        key={item.itemKey}
        aria-label={`${meta.app} notification details`}
      >
        <div className="item-detail-heading">
          <AppIcon app={meta.appId} />
          <strong>{item.title}</strong>
          <Badge
            variant={item.level === "urgent" ? "destructive" : "secondary"}
          >
            Source {item.level}
          </Badge>
        </div>
        <p className="muted">
          {meta.sender} · {item.instanceId} ·{" "}
          <time dateTime={new Date(meta.receivedAt).toISOString()}>
            {new Date(meta.receivedAt).toLocaleString()}
          </time>
        </p>
        {item.detail && <p>{item.detail}</p>}
        <p className="muted">
          {item.state === "snoozed" ? "Later" : item.state} · {etaText(item)}
          {!item.source.connected ? " · Source offline" : ""}
          {!item.timeReliable ? " · Source clock uncertain" : ""}
        </p>
        <div className="item-actions">
          <Button
            variant="secondary"
            size="sm"
            disabled={pending || readOnly}
            onClick={() =>
              operate(item, item.state === "paused" ? "resume" : "pause")
            }
          >
            <Icon
              name={item.state === "paused" ? "play" : "pause"}
              data-icon="inline-start"
            />
            {item.state === "paused" ? "Resume" : "Pause"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={pending || readOnly}
            onClick={() => operate(item, "end")}
          >
            <Icon name="end" data-icon="inline-start" />
            End
          </Button>
          {item.actionKeys.includes("primary") && (
            <Button
              variant="secondary"
              size="sm"
              disabled={
                readOnly ||
                pending ||
                !item.actionAvailable ||
                snapshot.displaying?.itemKey !== item.itemKey ||
                snapshot.health.status !== "healthy"
              }
              onClick={() =>
                void mutate("/actions", {
                  requestId: crypto.randomUUID(),
                  itemKey: item.itemKey,
                  generation: snapshot.generation,
                  actionKey: "primary",
                })
              }
            >
              <Icon name="play" data-icon="inline-start" />
              Run action
            </Button>
          )}
        </div>
        {snapshot.actions
          .filter((action) => action.itemKey === item.itemKey)
          .slice(-1)
          .map((action) => (
            <p className="action-result" key={action.id}>
              Action: {action.status}
              {action.status === "unknown"
                ? " · Check the source before retrying."
                : ""}
            </p>
          ))}
      </section>
    );
  };
  return (
    <div ref={scope} className="queue-scroll">
      <Table className="queue-table" aria-label="Display queue">
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id} scope="col">
                  {header.isPlaceholder ? null : (
                    <table.FlexRender header={header} />
                  )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => {
            const group = row.original;
            return (
              <Fragment key={row.id}>
                <TableRow
                  data-motion-row={group.groupId}
                  className={cn(group.current && "current-row")}
                >
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
                <TableRow
                  className="details-row"
                  aria-hidden={!group.open || undefined}
                >
                  <TableCell colSpan={columns.length}>
                    <Collapsible open={group.open}>
                      <CollapsibleContent
                        id={`details-${encodeURIComponent(group.groupId)}`}
                        className="motion-collapse"
                        inert={!group.open}
                      >
                        <div className="queue-detail-content">
                          {group.memberKeys
                            .map((key) =>
                              snapshot.items.find(
                                (member) => member.itemKey === key,
                              ),
                            )
                            .filter((member): member is QueueItem => !!member)
                            .map(details)}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </TableCell>
                </TableRow>
              </Fragment>
            );
          })}
          {!snapshot.items.length && (
            <TableRow>
              <TableCell colSpan={columns.length}>
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>Your queue is clear</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
