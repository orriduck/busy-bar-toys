import { Fragment, useCallback, useMemo, useState } from "react";
import { etaText, queueMetadata } from "./api";
import type { Snapshot, QueueItem, Mutate } from "./api";
import { AppIcon, Icon } from "./common";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
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

type QueueRow = {
  groupId: string;
  memberKeys: string[];
  item: QueueItem;
  meta: ReturnType<typeof queueMetadata>;
  open: boolean;
  current: boolean;
  toggle: (id: string) => void;
};
const features = tableFeatures({});
const column = createColumnHelper<typeof features, QueueRow>();
const columns = column.columns([
  column.accessor((row) => row.meta.app, {
    id: "app",
    header: "App",
    cell: ({ row }) => {
      const { groupId, meta, open, toggle } = row.original;
      return (
        <Button
          variant="ghost"
          className="queue-open"
          aria-expanded={open}
          aria-controls={`details-${encodeURIComponent(groupId)}`}
          aria-label={`${open ? "Hide" : "Show"} ${meta.app} details from ${meta.sender}`}
          onClick={() => toggle(groupId)}
        >
          <AppIcon app={meta.appId} />
          <span>{meta.app}</span>
        </Button>
      );
    },
  }),
  column.accessor((row) => row.meta.sender, {
    id: "sender",
    header: "Sender",
    cell: ({ row }) => (
      <span className="sender" title={row.original.item.instanceId}>
        <Icon name="computer" />
        {row.original.meta.sender}
      </span>
    ),
  }),
  column.accessor((row) => row.meta.receivedAt, {
    id: "received",
    header: "Received",
    cell: ({ row }) => {
      const date = new Date(row.original.meta.receivedAt);
      return (
        <time dateTime={date.toISOString()} title={date.toLocaleString()}>
          {date.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </time>
      );
    },
  }),
]);
export function Queue({
  snapshot,
  mutate,
  pending,
}: {
  snapshot: Snapshot;
  mutate: Mutate;
  pending: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
    return [...groups, ...orphaned].map((group): QueueRow => ({
      groupId: group.groupId,
      memberKeys: group.memberKeys,
      item: group.representativeItem!,
      meta: queueMetadata(group.representativeItem!, snapshot),
      open: expanded.has(group.groupId),
      current:
        snapshot.health.status === "healthy" &&
        group.memberKeys.includes(snapshot.displaying?.itemKey || ""),
      toggle,
    }));
  }, [snapshot, expanded, toggle]);
  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => row.groupId,
  });
  const operate = (item: QueueItem, operation: string) =>
    void mutate("/items", {
      itemKey: item.itemKey,
      operation,
      expectedRevision: snapshot.revision,
    });
  const details = (item: QueueItem) => {
    const meta = queueMetadata(item, snapshot);
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
            {item.level}
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
            disabled={pending}
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
            disabled={pending}
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
    <div className="queue-scroll">
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
                <TableRow className={cn(group.current && "current-row")}>
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
                {group.open && (
                  <TableRow className="details-row">
                    <TableCell
                      colSpan={columns.length}
                      id={`details-${encodeURIComponent(group.groupId)}`}
                    >
                      {group.memberKeys
                        .map((key) =>
                          snapshot.items.find(
                            (member) => member.itemKey === key,
                          ),
                        )
                        .filter((member): member is QueueItem => !!member)
                        .map(details)}
                    </TableCell>
                  </TableRow>
                )}
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
