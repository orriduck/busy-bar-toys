import { useState } from "react";
import type { ReactNode } from "react";
import { etaText, time } from "./api";
import type { Snapshot, QueueItem, Mutate } from "./api";
import { Icon, serviceName } from "./common";
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
  const rows = snapshot.groups
    .map((group) => ({
      ...group,
      representativeItem: snapshot.items.find(
        (i) => i.itemKey === group.representative,
      ),
    }))
    .filter((group) => group.representativeItem);
  const represented = new Set(rows.flatMap((g) => g.memberKeys));
  const dormant = snapshot.items.filter((i) => !represented.has(i.itemKey));
  const operate = (item: QueueItem, operation: string) =>
    void mutate("/items", {
      itemKey: item.itemKey,
      operation,
      expectedRevision: snapshot.revision,
    });
  function cells(item: QueueItem, order: ReactNode) {
    return (
      <>
        <td className="order">{order}</td>
        <td>
          <strong>{item.title}</strong>
          <span className="row-detail">
            {serviceName(snapshot, item.serviceId)} · {item.instanceId}
          </span>
          {item.detail && (
            <span className="row-detail item-detail">{item.detail}</span>
          )}
          <span className="row-meta">
            <b className={item.level}>{item.level}</b> · First seen{" "}
            {time(item.firstRecognizedAt)}
            {!item.timeReliable && " · Source clock uncertain"}
          </span>
        </td>
        <td>
          <span className={"badge " + item.state}>
            {item.state === "snoozed" ? "Later" : item.state}
          </span>
        </td>
        <td className="eta">{etaText(item)}</td>
        <td className="row-actions">
          <button
            disabled={pending}
            title={item.state === "paused" ? "Resume item" : "Pause item"}
            onClick={() =>
              operate(item, item.state === "paused" ? "resume" : "pause")
            }
          >
            <Icon name={item.state === "paused" ? "play" : "pause"} />
            <span>{item.state === "paused" ? "Resume" : "Pause"}</span>
          </button>
          <button
            disabled={pending}
            title="End item"
            onClick={() => operate(item, "end")}
          >
            <Icon name="end" />
            <span>End</span>
          </button>
        </td>
      </>
    );
  }
  return (
    <div className="queue-scroll">
      <table className="queue-table">
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Notification</th>
            <th scope="col">State</th>
            <th scope="col">Start</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((group) => {
            const item = group.representativeItem!;
            const multiple = group.memberKeys.length > 1;
            const open = expanded.has(group.groupId);
            return (
              <QueueGroup key={group.groupId}>
                <tr>
                  {cells(
                    item,
                    <span>
                      {group.order < 0 ? "—" : group.order + 1}
                      {multiple && (
                        <button
                          className={"expand " + (open ? "open" : "")}
                          aria-expanded={open}
                          aria-label={`${open ? "Collapse" : "Expand"} ${group.memberKeys.length} grouped items`}
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
                          <Icon name="chevron" />
                        </button>
                      )}
                    </span>,
                  )}{" "}
                </tr>
                {multiple && (
                  <tr className="group-count">
                    <td />
                    <td colSpan={4}>
                      {group.memberKeys.length} grouped items ·{" "}
                      {open ? "All members below" : "Expand to see every item"}
                    </td>
                  </tr>
                )}
                {open &&
                  group.memberKeys.map((key, index) => {
                    const child = snapshot.items.find((i) => i.itemKey === key);
                    return (
                      child && (
                        <tr className="child" key={key}>
                          {cells(
                            child,
                            group.order < 0
                              ? "—"
                              : `${group.order + 1}.${index + 1}`,
                          )}
                        </tr>
                      )
                    );
                  })}
              </QueueGroup>
            );
          })}
          {dormant.map((item) => (
            <tr key={item.itemKey}>{cells(item, "—")}</tr>
          ))}
          {snapshot.items.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                <Icon name="device" />
                <strong>Your queue is clear</strong>
                <span>
                  The native calendar stays on until a service has something to
                  show.
                </span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
function QueueGroup({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
