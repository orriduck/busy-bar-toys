import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { etaText } from "./api";
import { queueMetadata, compactSender } from "./queue-metadata";
import {
  ChevronDown,
  Repeat2,
  Pause,
  LoaderCircle,
  ListOrdered,
} from "lucide-react";
import { PriorityGroupBadge } from "./priority-group-badge";
import type { Snapshot, QueueItem, Mutate } from "./api";
import { AppIcon, Icon } from "./common";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Progress } from "./components/ui/progress";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "./components/ui/empty";
import { cn } from "./lib/utils";
import { receivedTime } from "./queue-playback";
import { queueLayout, rotationServices } from "./queue-layout";
import { useListMotion, useMotion, MotionFeedback } from "./motion";
import { useQueuePresence, QueueDeparture } from "./queue-motion";
import { MetadataTile } from "./metadata-tiles";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";

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
  const { enabled } = useMotion();
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
  const data = useMemo(
    () => queueLayout(snapshot, elapsed),
    [snapshot, elapsed],
  );
  const entries = useQueuePresence(data, enabled);
  const scope = useRef<HTMLDivElement>(null);
  const focused = useRef<string | null>(null);
  const structure = JSON.stringify(
    data.map((group) => [
      group.groupId,
      expanded.has(group.groupId),
      group.current,
    ]),
  );
  useListMotion(scope, structure);
  useLayoutEffect(() => {
    if (
      focused.current &&
      !data.some((row) => row.groupId === focused.current)
    ) {
      const active = document.activeElement;
      if (active === document.body || active?.closest("[data-departing]"))
        scope.current?.focus({ preventScroll: true });
      focused.current = null;
    }
  }, [structure]);
  useEffect(
    () =>
      setExpanded((previous) => {
        const live = new Set(data.map((row) => row.groupId));
        const next = new Set([...previous].filter((id) => live.has(id)));
        return next.size === previous.size ? previous : next;
      }),
    [snapshot],
  );
  const rotating = rotationServices(data);
  const playing = data.find((row) => row.current);
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
        <div className="metadata-grid queue-provenance">
          <MetadataTile
            label="Sender"
            detail={meta.sender.split(" · ").slice(1).join(" · ")}
          >
            <code title={meta.sender}>
              {compactSender(meta.sender).split(" · ")[0]}
            </code>
          </MetadataTile>
          <MetadataTile label="Received">
            <time dateTime={new Date(meta.receivedAt).toISOString()}>
              {new Date(meta.receivedAt).toLocaleString()}
            </time>
          </MetadataTile>
        </div>
        <Collapsible className="queue-source-details">
          <CollapsibleTrigger
            render={<Button type="button" variant="disclosure" size="sm" />}
          >
            Source identity <ChevronDown data-icon="inline-end" />
          </CollapsibleTrigger>
          <CollapsibleContent className="motion-collapse">
            <code>{item.instanceId}</code>
            <code>{meta.sender}</code>
          </CollapsibleContent>
        </Collapsible>
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
                !data.some(
                  (row) => row.current && row.item.itemKey === item.itemKey,
                )
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
    <div
      ref={scope}
      className="queue-scroll playback-queue"
      tabIndex={-1}
      aria-label="Display queue"
    >
      <header className="queue-heading">
        <h2>
          <ListOrdered aria-hidden="true" /> On your Bar
        </h2>
        <span>{data.length} in queue</span>
      </header>
      {rotating.length > 1 && (
        <div className="queue-rotation-note">
          <Repeat2 aria-hidden="true" />
          <span>
            {playing?.rotating
              ? "Taking turns by Hold"
              : "Background services take turns by Hold"}
          </span>
          <span
            className="queue-rotation-icons"
            aria-label={rotating.map((row) => row.meta.app).join(" and ")}
          >
            {[...rotating]
              .sort((a, b) => a.item.serviceId.localeCompare(b.item.serviceId))
              .slice(0, 4)
              .map((row) => (
                <span key={row.item.serviceId} data-active={row.current}>
                  <AppIcon app={row.meta.appId} />
                </span>
              ))}
          </span>
        </div>
      )}
      <ol className="queue-flow" aria-label="Playback order">
        {entries.map((entry) => {
          const row = entry.value;
          if (entry.until !== null)
            return (
              <QueueDeparture key={entry.id}>
                <div data-departing className="queue-exit-label">
                  <AppIcon app={row.meta.appId} />
                  <span>{row.meta.app}</span>
                </div>
              </QueueDeparture>
            );
          const index = data.findIndex((r) => r.groupId === row.groupId);
          const waitingNumber = index + 1 - (playing ? 1 : 0);
          const paused =
            row.item.state === "paused" || row.item.state === "snoozed";
          const label = row.current
            ? "Playing"
            : row.applying
              ? "Switching"
              : paused
                ? "Paused"
                : row.rotating
                  ? "In rotation"
                  : "Queued";
          const open = expanded.has(row.groupId);
          return (
            <li
              key={entry.id}
              data-motion-row={row.groupId}
              data-playing={row.current}
              className="queue-flow-row"
              onFocusCapture={() => {
                focused.current = row.groupId;
              }}
            >
              <div className="queue-row-summary">
                <span
                  className={cn("queue-position", row.current && "is-playing")}
                  aria-label={label}
                >
                  {row.current ? (
                    <span className="queue-equalizer" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : row.applying ? (
                    <LoaderCircle aria-hidden="true" />
                  ) : paused ? (
                    <Pause aria-hidden="true" />
                  ) : row.rotating ? (
                    <Repeat2 aria-hidden="true" />
                  ) : (
                    waitingNumber
                  )}
                </span>
                <Button
                  variant="disclosure"
                  className="queue-open"
                  aria-expanded={open}
                  aria-controls={`details-${encodeURIComponent(row.groupId)}`}
                  aria-label={`${open ? "Hide" : "Show"} ${row.meta.app} details from ${row.meta.sender}, ${label.toLowerCase()}`}
                  onClick={() => toggle(row.groupId)}
                >
                  <AppIcon app={row.meta.appId} />
                  <span className="queue-app-copy">
                    <span className="queue-app-name">
                      <span title={row.meta.app}>{row.meta.app}</span>
                      {row.memberKeys.length > 1 && (
                        <Badge variant="secondary">
                          {row.memberKeys.length}
                        </Badge>
                      )}
                    </span>
                    <span className="queue-state">
                      <MotionFeedback value={label}>{label}</MotionFeedback>
                      <span aria-hidden="true">·</span>
                      <span title={row.meta.sender}>
                        {compactSender(row.meta.sender).split(" · ")[0]}
                      </span>
                    </span>
                  </span>
                  <span className="queue-row-end">
                    {row.meta.priorityGroup && (
                      <PriorityGroupBadge group={row.meta.priorityGroup} />
                    )}
                    <time
                      dateTime={new Date(row.meta.receivedAt).toISOString()}
                      title={`Received ${new Date(row.meta.receivedAt).toLocaleString()}`}
                    >
                      {receivedTime(row.meta.receivedAt)}
                    </time>
                  </span>
                  <ChevronDown
                    className="queue-disclosure"
                    aria-hidden="true"
                  />
                </Button>
                {row.current && (
                  <Progress
                    className="queue-playback-line"
                    data-size="thin"
                    value={
                      row.progress === null ? null : Math.round(row.progress)
                    }
                    aria-label={`${row.meta.app} playback`}
                    aria-valuetext={
                      row.progress === null
                        ? "Playing · duration unknown"
                        : undefined
                    }
                  />
                )}
              </div>
              <Collapsible open={open}>
                <CollapsibleContent
                  id={`details-${encodeURIComponent(row.groupId)}`}
                  className="motion-collapse"
                  inert={!open}
                >
                  <div className="queue-detail-content">
                    {row.memberKeys
                      .map((key) =>
                        snapshot.items.find((member) => member.itemKey === key),
                      )
                      .filter((member): member is QueueItem => !!member)
                      .map(details)}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </li>
          );
        })}
      </ol>
      {!entries.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Your queue is clear</EmptyTitle>
            <EmptyDescription>New activity will appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {data.length} in queue.{" "}
        {playing ? `${playing.meta.app} playing` : "No confirmed playback"}
      </span>
    </div>
  );
}
