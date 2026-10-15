import { Fragment, useState } from "react";
import { etaText, queueMetadata } from "./api";
import type { Snapshot, QueueItem, Mutate } from "./api";
import { AppIcon, Icon } from "./common";
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
  const groups = snapshot.groups
    .map((group) => ({
      ...group,
      representativeItem: snapshot.items.find(
        (i) => i.itemKey === group.representative,
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
          <span className={`badge ${item.level}`}>{item.level}</span>
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
          <button
            disabled={pending}
            onClick={() =>
              operate(item, item.state === "paused" ? "resume" : "pause")
            }
          >
            <Icon name={item.state === "paused" ? "play" : "pause"} />
            {item.state === "paused" ? "Resume" : "Pause"}
          </button>
          <button disabled={pending} onClick={() => operate(item, "end")}>
            <Icon name="end" />
            End
          </button>
          {item.actionKeys.includes("primary") && (
            <button
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
              <Icon name="play" />
              Run action
            </button>
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
      <table className="queue-table" aria-label="Display queue">
        <thead>
          <tr>
            <th scope="col">App</th>
            <th scope="col">Sender</th>
            <th scope="col">Received</th>
          </tr>
        </thead>
        <tbody>
          {[...groups, ...orphaned].map((group) => {
            const item = group.representativeItem!,
              meta = queueMetadata(item, snapshot),
              open = expanded.has(group.groupId);
            const current =
              snapshot.health.status === "healthy" &&
              group.memberKeys.includes(snapshot.displaying?.itemKey || "");
            return (
              <Fragment key={group.groupId}>
                <tr className={current ? "current-row" : ""}>
                  <td>
                    <button
                      className="queue-open"
                      aria-expanded={open}
                      aria-controls={`details-${encodeURIComponent(group.groupId)}`}
                      aria-label={`${open ? "Hide" : "Show"} ${meta.app} details from ${meta.sender}`}
                      onClick={() =>
                        setExpanded((previous) => {
                          const next = new Set(previous);
                          next.has(group.groupId)
                            ? next.delete(group.groupId)
                            : next.add(group.groupId);
                          return next;
                        })
                      }
                    >
                      <AppIcon app={meta.appId} />
                      <span>{meta.app}</span>
                    </button>
                  </td>
                  <td title={item.instanceId}>
                    <span className="sender">
                      <Icon name="computer" />
                      {meta.sender}
                    </span>
                  </td>
                  <td>
                    <time
                      dateTime={new Date(meta.receivedAt).toISOString()}
                      title={new Date(meta.receivedAt).toLocaleString()}
                    >
                      {new Date(meta.receivedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                    </time>
                  </td>
                </tr>
                {open && (
                  <tr className="details-row">
                    <td
                      colSpan={3}
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
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {!snapshot.items.length && (
            <tr>
              <td colSpan={3} className="empty">
                Your queue is clear
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
