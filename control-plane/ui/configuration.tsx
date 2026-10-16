import { useMemo, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, GripVertical } from "lucide-react";
import type { Snapshot, Mutate, Service, CredentialValue } from "./api";
import { Card, CardHeader, CardContent } from "./components/ui/card";
import { cn } from "./lib/utils";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./components/ui/collapsible";
import { ServiceEditor } from "./services";
import { SettingNumber } from "./setting-number";
import { PriorityBadge } from "./policy-field";
import { priorityOrder, serviceLabel, computerIds } from "./service-layout";
function ConfigurationRow({
  service,
  rank,
  open,
  onOpen,
  snapshot,
  mutate,
  pending,
  onCredential,
}: {
  service: Service;
  rank: number;
  open: boolean;
  onOpen: (value: boolean) => void;
  snapshot: Snapshot;
  mutate: Mutate;
  pending: boolean;
  onCredential: (value: CredentialValue) => void;
}) {
  const sortable = useSortable({ id: service.id, disabled: pending });
  return (
    <Card
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        "configuration-row gap-0 p-0",
        sortable.isDragging && "z-10 bg-popover shadow-lg ring-1 ring-primary",
      )}
    >
      <Collapsible open={open} onOpenChange={onOpen}>
        <CardHeader className="configuration-summary">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="drag-handle"
            aria-label={`Move ${service.name}`}
            disabled={pending}
            {...sortable.attributes}
            {...sortable.listeners}
          >
            <GripVertical />
          </Button>
          <span className="configuration-rank" aria-label={`Position ${rank}`}>
            <span aria-hidden="true">
              <SettingNumber value={rank} />
            </span>
          </span>
          <CollapsibleTrigger
            render={
              <Button variant="disclosure" className="configuration-open" />
            }
          >
            <span className="configuration-name">
              <strong>{serviceLabel(service)}</strong>
              <span>
                {computerIds(service, snapshot.items).join(" · ") || service.id}
              </span>
            </span>
            {!service.config.enabled && <Badge variant="secondary">Off</Badge>}
            <PriorityBadge value={service.config.priority} />
            <ChevronDown className={open ? "chevron-open" : ""} />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent keepMounted>
          <CardContent className="configuration-detail">
            <ServiceEditor
              service={service}
              configRevision={snapshot.configRevision}
              mutate={mutate}
              pending={pending}
              onCredential={onCredential}
            />
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
export function ConfigurationList({
  snapshot,
  mutate,
  pending,
  onCredential,
}: {
  snapshot: Snapshot;
  mutate: Mutate;
  pending: boolean;
  onCredential: (value: CredentialValue) => void;
}) {
  const ordered = useMemo(
    () => priorityOrder(snapshot.services),
    [snapshot.services],
  );
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState("");
  const dragBase = useRef<{ revision: number; ids: string[] } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const ids = dragOrder || ordered.map((s) => s.id);
  const start = () => {
    const value = {
      revision: snapshot.configRevision,
      ids: ordered.map((s) => s.id),
    };
    dragBase.current = value;
    setDragOrder(value.ids);
    setStatus("");
  };
  const end = async (event: DragEndEvent) => {
    const base = dragBase.current;
    dragBase.current = null;
    if (!base || !event.over || event.active.id === event.over.id) {
      setDragOrder(null);
      return;
    }
    if (base.revision !== snapshot.configRevision) {
      setDragOrder(null);
      setStatus("Order changed elsewhere. Try again.");
      return;
    }
    const from = base.ids.indexOf(String(event.active.id)),
      to = base.ids.indexOf(String(event.over.id));
    if (from < 0 || to < 0) {
      setDragOrder(null);
      return;
    }
    const serviceIds = arrayMove(base.ids, from, to);
    setDragOrder(serviceIds);
    setStatus("Saving order…");
    const result = await mutate("/services/order", {
      expectedRevision: base.revision,
      serviceIds,
    });
    setDragOrder(null);
    setStatus(
      result
        ? "Order saved."
        : "Order was not saved. Review the latest order and try again.",
    );
  };
  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={start}
        onDragCancel={() => {
          dragBase.current = null;
          setDragOrder(null);
        }}
        onDragEnd={(event) => void end(event)}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div
            className="configuration-list"
            aria-label="Service priority order"
          >
            {ids.map((id, index) => {
              const service = snapshot.services.find((s) => s.id === id);
              return (
                service && (
                  <ConfigurationRow
                    key={id}
                    service={service}
                    rank={index + 1}
                    open={expanded.has(id)}
                    onOpen={(open) =>
                      setExpanded((previous) => {
                        const next = new Set(previous);
                        open ? next.add(id) : next.delete(id);
                        return next;
                      })
                    }
                    snapshot={snapshot}
                    mutate={mutate}
                    pending={pending}
                    onCredential={onCredential}
                  />
                )
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
      <p className="configuration-status" role="status">
        {status}
      </p>
    </>
  );
}
