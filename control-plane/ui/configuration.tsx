import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  ChevronRight,
  GripVertical,
  LockKeyhole,
  MoreHorizontal,
} from "lucide-react";
import type { Snapshot, Mutate, Service, CredentialValue } from "./api";
import { cn } from "./lib/utils";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "./components/ui/dropdown-menu";
import { Empty, EmptyHeader, EmptyTitle } from "./components/ui/empty";
import { ServiceDetails } from "./service-details";
import { ServiceEditor } from "./services";
import { SettingNumber } from "./setting-number";
import { serviceLabel } from "./service-layout";
import { useListMotion } from "./motion";
import {
  PRIORITY_GROUPS,
  globalPriorityGroups,
  moveOwnedService,
  ownedPriorityGroups,
  priorityGroupLabels,
  priorityGroupDescriptions,
  type PriorityGroup,
  type OwnedPriorityGroups,
} from "./priority-groups";
const verticalOrder: Modifier = ({ transform }) => ({ ...transform, x: 0 });
const orderModifiers = [verticalOrder];
const groupDropId = (group: PriorityGroup) => `priority-group:${group}`;
const groupCollision: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) {
    const group = args.active.data.current?.group;
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (entry) =>
          entry.data.current?.owned === true &&
          entry.data.current?.group === group,
      ),
    });
  }
  const pointer = pointerWithin(args);
  return pointer.length ? pointer : closestCenter(args);
};
/** Arrow keys sort the owned queue. The library menu handles global group moves. */
const ownQueueKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { context, currentCoordinates },
) => {
  if (event.code !== "ArrowDown" && event.code !== "ArrowUp") return undefined;
  event.preventDefault();
  const { active, over, collisionRect, droppableContainers, droppableRects } =
    context;
  if (!active || !collisionRect) return undefined;
  const group = active.data.current?.group;
  const own = droppableContainers
    .getEnabled()
    .filter(
      (entry) =>
        entry.data.current?.owned === true &&
        entry.data.current?.group === group,
    )
    .sort(
      (a, b) => a.data.current?.sortable.index - b.data.current?.sortable.index,
    );
  const current = own.findIndex(
    (entry) => entry.id === (over?.id ?? active.id),
  );
  const target = own[current + (event.code === "ArrowDown" ? 1 : -1)];
  const rect = target && droppableRects.get(target.id);
  return rect
    ? {
        x: currentCoordinates.x,
        y: currentCoordinates.y + rect.top - collisionRect.top,
      }
    : undefined;
};
function PrioritySection({
  group,
  count,
  pending,
  children,
}: {
  group: PriorityGroup;
  count: number;
  pending: boolean;
  children: ReactNode;
}) {
  const drop = useDroppable({
    id: groupDropId(group),
    disabled: pending,
    data: { group },
  });
  return (
    <section
      className="configuration-priority-group"
      data-priority-group={group}
      aria-label={`${priorityGroupLabels[group]} services`}
    >
      <div
        ref={drop.setNodeRef}
        className={cn("configuration-group-target", drop.isOver && "is-over")}
        data-group-target={group}
      >
        <div className="configuration-group-heading">
          <span className="priority-group-dot" aria-hidden="true" />
          <h3>{priorityGroupLabels[group]}</h3>
          <span className="configuration-group-count">
            <SettingNumber value={count} />
          </span>
        </div>
        <p>{priorityGroupDescriptions[group]}</p>
        {!count && (
          <Empty className="configuration-group-empty">
            <EmptyHeader>
              <EmptyTitle>No services · drop yours here</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </div>
      {children}
    </section>
  );
}
function ConfigurationRow({
  service,
  group,
  rank,
  selected,
  onSelect,
  editable,
  pending,
  onMove,
}: {
  service: Service;
  group: PriorityGroup;
  rank: number;
  selected: boolean;
  onSelect: () => void;
  editable: boolean;
  pending: boolean;
  onMove: (group: PriorityGroup) => void;
}) {
  const sortable = useSortable({
    id: service.id,
    disabled: { draggable: !editable || pending, droppable: pending },
    data: { group, owned: editable },
  });
  return (
    <div
      ref={sortable.setNodeRef}
      style={
        editable
          ? {
              transform: CSS.Transform.toString(sortable.transform),
              transition: sortable.transition,
            }
          : undefined
      }
      className={cn(
        "configuration-order-row",
        selected && "is-selected",
        sortable.isDragging && "is-dragging",
      )}
      data-service-id={service.id}
      data-owned={editable}
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
        <span
          className="configuration-rank"
          aria-label={`Computer queue position ${rank}`}
        >
          <SettingNumber value={rank} />
        </span>
        <Button
          type="button"
          variant="ghost"
          className="configuration-select"
          aria-pressed={selected}
          onClick={onSelect}
        >
          <span className="configuration-service-label">
            <span>{serviceLabel(service)}</span>
            <small title={service.computerId ?? "Unassigned computer"}>
              {service.computerId?.slice(0, 8) ?? "Unassigned"}
              {editable ? " · This computer" : " · Read only"}
            </small>
          </span>
          {!service.config.enabled && <Badge variant="secondary">Off</Badge>}
          <ChevronRight />
        </Button>
        {editable && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={pending}
                  aria-label={`Priority group for ${service.name}`}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Move to group</DropdownMenuLabel>
                {PRIORITY_GROUPS.map((target) => (
                  <DropdownMenuItem
                    key={target}
                    disabled={target === group}
                    onClick={() => onMove(target)}
                  >
                    Move to {priorityGroupLabels[target]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
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
  const [selected, setSelected] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [draft, setDraft] = useState<{
    owner: string;
    revision: number;
    groups: OwnedPriorityGroups;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [restoreFocus, setRestoreFocus] = useState<{
    serviceId: string;
    target: "menu" | "handle";
    owner: string;
  } | null>(null);
  const list = useRef<HTMLDivElement>(null),
    detail = useRef<HTMLDivElement>(null);
  const latest = useRef({ snapshot, ownerComputerId });
  latest.current = { snapshot, ownerComputerId };
  const inFlight = useRef(false);
  const dragBase = useRef<{
    revision: number;
    owner: string | null;
    groups: OwnedPriorityGroups;
  } | null>(null);
  const ownGroups = ownedPriorityGroups(snapshot, ownerComputerId);
  const visibleDraft =
    draft?.revision === snapshot.configRevision &&
    draft.owner === ownerComputerId
      ? draft.groups
      : null;
  const groups = globalPriorityGroups(snapshot, ownerComputerId, visibleDraft);
  const ownIds = PRIORITY_GROUPS.flatMap(
    (group) => (visibleDraft ?? ownGroups)[group],
  );
  const blocked = pending || saving;
  const visibleId = snapshot.services.some((s) => s.id === selected)
    ? selected
    : (ownIds[0] ?? groups.find((g) => g.services.length)?.services[0]?.id);
  useEffect(() => {
    if (visibleId && selected !== visibleId) setSelected(visibleId);
  }, [visibleId, selected]);
  useEffect(() => {
    if (mobileDetail && window.matchMedia("(max-width:900px)").matches)
      detail.current
        ?.querySelector<HTMLHeadingElement>("section:not([hidden]) h2")
        ?.focus({ preventScroll: true });
  }, [mobileDetail, visibleId]);
  useEffect(() => {
    const base = dragBase.current;
    if (
      base &&
      (base.revision !== snapshot.configRevision ||
        base.owner !== ownerComputerId)
    ) {
      dragBase.current = null;
      setDraft(null);
      setDragging(false);
      setStatus("Configuration changed elsewhere. Try again.");
    }
  }, [snapshot.configRevision, ownerComputerId]);
  useEffect(() => {
    if (!restoreFocus) return;
    setRestoreFocus(null);
    if (restoreFocus.owner !== ownerComputerId) return;
    const active = document.activeElement;
    // A user may have entered an editor or selected another control while saving.
    if (active && active !== document.body && !list.current?.contains(active))
      return;
    if (active && active !== document.body) {
      const currentRow = active.closest<HTMLElement>("[data-service-id]");
      if (currentRow?.dataset.serviceId !== restoreFocus.serviceId) return;
    }
    const row = Array.from(
      list.current?.querySelectorAll<HTMLElement>("[data-service-id]") ?? [],
    ).find((node) => node.dataset.serviceId === restoreFocus.serviceId);
    const target = row?.querySelector<HTMLButtonElement>(
      restoreFocus.target === "menu"
        ? '[data-slot="dropdown-menu-trigger"]'
        : ".drag-handle",
    );
    if (target?.getClientRects().length) target.focus({ preventScroll: true });
  }, [restoreFocus, ownerComputerId]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: ownQueueKeyboardCoordinates,
    }),
  );
  useListMotion(
    list,
    JSON.stringify(groups.map((g) => [g.id, g.services.map((s) => s.id)])),
    dragging,
  );
  const persist = async (
    next: OwnedPriorityGroups,
    base: OwnedPriorityGroups,
    revision: number,
    owner: string | null,
    focus?: { serviceId: string; target: "menu" | "handle" },
  ) => {
    if (
      inFlight.current ||
      pending ||
      !owner ||
      next === base ||
      JSON.stringify(next) === JSON.stringify(base)
    )
      return;
    if (
      latest.current.snapshot.configRevision !== revision ||
      latest.current.ownerComputerId !== owner
    ) {
      setDraft(null);
      setStatus("Configuration changed elsewhere. Try again.");
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setDraft({ revision, owner, groups: next });
    setStatus("Saving priority groups…");
    try {
      const result = await mutate("/services/order", {
        expectedRevision: revision,
        groups: next,
      });
      setStatus(
        result
          ? "Priority groups saved."
          : "Priority groups were not saved. Review the latest configuration and try again.",
      );
    } catch {
      setStatus(
        "Priority groups were not saved. Review the latest configuration and try again.",
      );
    } finally {
      inFlight.current = false;
      setSaving(false);
      setDraft(null);
      if (focus) setRestoreFocus({ ...focus, owner });
    }
  };
  const end = async (event: DragEndEvent) => {
    const base = dragBase.current;
    dragBase.current = null;
    setDragging(false);
    setDraft(null);
    if (!base || !event.over || event.active.id === event.over.id) return;
    const activeId = String(event.active.id),
      targetId = String(event.over.id);
    // Foreign rows identify a global destination, never an insertion position.
    const foreignTarget = event.over.data.current?.owned === false;
    const targetGroup =
      PRIORITY_GROUPS.find((group) => groupDropId(group) === targetId) ??
      PRIORITY_GROUPS.find((group) => base.groups[group].includes(targetId)) ??
      (foreignTarget
        ? PRIORITY_GROUPS.find(
            (group) => group === event.over!.data.current?.group,
          )
        : undefined);
    if (!targetGroup) return;
    await persist(
      moveOwnedService(
        base.groups,
        activeId,
        targetGroup,
        targetId === groupDropId(targetGroup) || foreignTarget
          ? undefined
          : targetId,
      ),
      base.groups,
      base.revision,
      base.owner,
      event.activatorEvent.type.startsWith("key")
        ? { serviceId: activeId, target: "handle" }
        : undefined,
    );
  };
  return (
    <div className="configuration-workspace" data-detail={mobileDetail}>
      <div className="configuration-order-pane">
        <DndContext
          modifiers={orderModifiers}
          sensors={sensors}
          collisionDetection={groupCollision}
          accessibility={{
            screenReaderInstructions: {
              draggable:
                "Press Space to pick up your service. Use arrow keys to reorder, then Space to save. Use the priority group menu to move to any group, including an empty group.",
            },
          }}
          onDragStart={({ active }) => {
            if (blocked || !ownIds.includes(String(active.id))) return;
            dragBase.current = {
              revision: snapshot.configRevision,
              owner: ownerComputerId,
              groups: ownGroups,
            };
            setDragging(true);
            setStatus("");
          }}
          onDragCancel={() => {
            dragBase.current = null;
            setDraft(null);
            setDragging(false);
          }}
          onDragEnd={(event) => void end(event)}
        >
          <SortableContext
            items={ownIds}
            strategy={verticalListSortingStrategy}
          >
            <div
              ref={list}
              className="configuration-priority-groups"
              aria-label="Global service priority groups"
            >
              {groups.map((group) => {
                const ranks = new Map<string, number>();
                return (
                  <PrioritySection
                    key={group.id}
                    group={group.id}
                    count={group.services.length}
                    pending={blocked}
                  >
                    {group.services.map((service) => {
                      const computer = service.computerId ?? service.id;
                      const rank = (ranks.get(computer) ?? 0) + 1;
                      ranks.set(computer, rank);
                      return (
                        <ConfigurationRow
                          key={service.id}
                          service={service}
                          group={group.id}
                          rank={rank}
                          editable={
                            !!ownerComputerId &&
                            service.computerId === ownerComputerId
                          }
                          selected={service.id === visibleId}
                          pending={blocked}
                          onSelect={() => {
                            setSelected(service.id);
                            setMobileDetail(true);
                          }}
                          onMove={(target) =>
                            void persist(
                              moveOwnedService(ownGroups, service.id, target),
                              ownGroups,
                              snapshot.configRevision,
                              ownerComputerId,
                              { serviceId: service.id, target: "menu" },
                            )
                          }
                        />
                      );
                    })}
                  </PrioritySection>
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
            <ServiceDetails
              snapshot={snapshot}
              service={service}
              readOnly={service.computerId !== ownerComputerId}
            />
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
