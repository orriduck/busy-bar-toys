import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  ChevronRight,
  GripVertical,
  LockKeyhole,
  Monitor,
} from "lucide-react";
import type { Snapshot, Mutate, Service, CredentialValue } from "./api";
import { cn } from "./lib/utils";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { ServiceDetails } from "./service-details";
import { ServiceEditor } from "./services";
import { SettingNumber } from "./setting-number";
import { orderedDeviceGroups, serviceLabel } from "./service-layout";
import { useListMotion } from "./motion";
const verticalOrder: Modifier = ({ transform }) => ({ ...transform, x: 0 });
const orderModifiers = [verticalOrder];
function ConfigurationRow({
  service,
  rank,
  selected,
  onSelect,
  editable,
  pending,
}: {
  service: Service;
  rank: number;
  selected: boolean;
  onSelect: () => void;
  editable: boolean;
  pending: boolean;
}) {
  const sortable = useSortable({
    id: service.id,
    disabled: !editable || pending,
  });
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        "configuration-order-row",
        selected && "is-selected",
        sortable.isDragging && "is-dragging",
      )}
    >
      <div data-motion-row={service.id} className="configuration-order-inner">
        {editable ? (
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
        ) : (
          <LockKeyhole className="configuration-lock" aria-label="Read only" />
        )}
        <span className="configuration-rank" aria-label={`Position ${rank}`}>
          <SettingNumber value={rank} />
        </span>
        <Button
          type="button"
          variant="ghost"
          className="configuration-select"
          aria-pressed={selected}
          onClick={onSelect}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {serviceLabel(service)}
          </span>
          {!service.config.enabled && <Badge variant="secondary">Off</Badge>}
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
export function ConfigurationList({
  snapshot,
  mutate,
  pending,
  onCredential,
  ownerComputerId,
}: {
  snapshot: Snapshot;
  mutate: Mutate;
  pending: boolean;
  onCredential: (value: CredentialValue) => void;
  ownerComputerId: string | null;
}) {
  const groups = orderedDeviceGroups(snapshot);
  const [selected, setSelected] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [status, setStatus] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const own = groups.find((g) => g.name === ownerComputerId);
  const ownIds = own?.services.map((s) => s.id) ?? [];
  const dragBase = useRef<{ revision: number; ids: string[] } | null>(null);
  const visibleId = snapshot.services.some((s) => s.id === selected)
    ? selected
    : (ownIds[0] ?? groups[0]?.services[0]?.id);
  useEffect(() => {
    if (mobileDetail && window.matchMedia("(max-width:900px)").matches)
      detail.current
        ?.querySelector<HTMLHeadingElement>("section:not([hidden]) h2")
        ?.focus({ preventScroll: true });
  }, [mobileDetail, visibleId]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  useListMotion(
    list,
    JSON.stringify(
      groups.map((g) => [
        g.name,
        g.name === ownerComputerId && dragOrder
          ? dragOrder
          : g.services.map((s) => s.id),
      ]),
    ),
    dragOrder !== null,
  );
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
    <div className="configuration-workspace" data-detail={mobileDetail}>
      <div className="configuration-order-pane">
        <DndContext
          modifiers={orderModifiers}
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => {
            dragBase.current = {
              revision: snapshot.configRevision,
              ids: ownIds,
            };
            setDragOrder(ownIds);
            setStatus("");
          }}
          onDragCancel={() => {
            dragBase.current = null;
            setDragOrder(null);
          }}
          onDragEnd={(event) => void end(event)}
        >
          <SortableContext
            items={dragOrder ?? ownIds}
            strategy={verticalListSortingStrategy}
          >
            <div
              ref={list}
              className="configuration-computers"
              aria-label="Service order by computer"
            >
              {groups.map((group) => {
                const editable = group.name === ownerComputerId;
                const ids =
                  editable && dragOrder
                    ? dragOrder
                    : group.services.map((s) => s.id);
                return (
                  <section
                    key={group.name}
                    className="configuration-computer"
                    aria-label={`${group.name} service order`}
                  >
                    <div className="configuration-computer-heading">
                      <Monitor />
                      <span title={group.name}>{group.name.slice(0, 8)}</span>
                      <Badge variant="secondary">
                        {editable ? "This computer" : "Read only"}
                      </Badge>
                    </div>
                    {ids.map((id, index) => {
                      const service = group.services.find((s) => s.id === id);
                      return (
                        service && (
                          <ConfigurationRow
                            key={id}
                            service={service}
                            rank={index + 1}
                            editable={editable}
                            selected={id === visibleId}
                            pending={pending}
                            onSelect={() => {
                              setSelected(id);
                              setMobileDetail(true);
                            }}
                          />
                        )
                      );
                    })}
                  </section>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
        <p className="configuration-status" role="status">
          {status}
        </p>
      </div>
      <div ref={detail} className="configuration-editor-pane">
        <Button
          variant="ghost"
          size="sm"
          className="configuration-back"
          onClick={() => {
            setMobileDetail(false);
            requestAnimationFrame(() =>
              list.current
                ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
                ?.focus(),
            );
          }}
        >
          <ArrowLeft />
          Services
        </Button>
        {snapshot.services.map((service) => (
          <section
            key={service.id}
            hidden={service.id !== visibleId}
            inert={service.id !== visibleId}
            className="configuration-editor"
            aria-label={`${serviceLabel(service)} configuration`}
          >
            <div className="configuration-editor-heading">
              <div>
                <h2 tabIndex={-1} className="outline-none">
                  {serviceLabel(service)}
                </h2>
                <p className="break-all">{service.id}</p>
              </div>
              {service.computerId !== ownerComputerId && (
                <Badge variant="secondary">
                  <LockKeyhole />
                  Read only
                </Badge>
              )}
            </div>
            <div className="mb-4 border-b border-border pb-4">
              <ServiceDetails snapshot={snapshot} service={service} />
            </div>
            <ServiceEditor
              service={service}
              configRevision={snapshot.configRevision}
              mutate={mutate}
              pending={pending}
              onCredential={onCredential}
              readOnly={service.computerId !== ownerComputerId}
            />
          </section>
        ))}
      </div>
    </div>
  );
}
