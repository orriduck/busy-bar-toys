import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  rectIntersection,
  pointerWithin,
  useDroppable,
  useDraggable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
  type Modifier,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  ChevronRight,
  GripVertical,
  LockKeyhole,
  Laptop,
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
import { HelpTip } from "./policy-field";
import { ServiceDetails } from "./service-details";
import { ServiceEditor } from "./services";
import { SettingNumber } from "./setting-number";
import { deviceGroups, serviceLabel } from "./service-layout";
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
  const targets = {
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (entry) => entry.data.current?.group !== undefined,
    ),
  };
  // Whole-section centers can be nearer to an adjacent group than a row's
  // actual group. Keyboard drags follow the section containing the moved row.
  if (!args.pointerCoordinates) {
    const overlaps = rectIntersection(targets);
    return overlaps.length ? overlaps : closestCenter(targets);
  }
  const pointer = pointerWithin(targets);
  return pointer.length ? pointer : closestCenter(targets);
};
/** Arrow keys select a group; the same destination is available in the row menu. */
const groupKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { context, currentCoordinates },
) => {
  if (event.code !== "ArrowDown" && event.code !== "ArrowUp") return undefined;
  event.preventDefault();
  const { active, over, collisionRect, droppableRects } = context;
  if (!active || !collisionRect) return undefined;
  const group = over?.data.current?.group ?? active.data.current?.group;
  const current = PRIORITY_GROUPS.indexOf(group);
  const target =
    PRIORITY_GROUPS[current + (event.code === "ArrowDown" ? 1 : -1)];
  const rect = target && droppableRects.get(groupDropId(target));
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
      ref={drop.setNodeRef}
      className="configuration-priority-group"
      data-priority-group={group}
      aria-label={`${priorityGroupLabels[group]} services`}
    >
      <div
        className={cn("configuration-group-target", drop.isOver && "is-over")}
        data-group-target={group}
      >
        <div className="configuration-group-heading">
          <span className="priority-group-dot" aria-hidden="true" />
          <h3>{priorityGroupLabels[group]}</h3>
          <HelpTip label={priorityGroupLabels[group]}>
            {priorityGroupDescriptions[group]}
          </HelpTip>
          <span className="configuration-group-count">
            <SettingNumber value={count} />
          </span>
        </div>
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
  selected,
  onSelect,
  editable,
  pending,
  onMove,
}: {
  service: Service;
  group: PriorityGroup;
  selected: boolean;
  onSelect: () => void;
  editable: boolean;
  pending: boolean;
  onMove: (group: PriorityGroup) => void;
}) {
  const draggable = useDraggable({
    id: service.id,
    disabled: !editable || pending,
    data: { group, owned: editable },
  });
  return (
    <div
      ref={draggable.setNodeRef}
      style={
        editable
          ? {
              transform: CSS.Translate.toString(draggable.transform),
            }
          : undefined
      }
      className={cn(
        "configuration-order-row",
        selected && "is-selected",
        draggable.isDragging && "is-dragging",
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
            {...draggable.attributes}
            {...draggable.listeners}
          >
            <GripVertical />
          </Button>
        ) : (
          <span className="configuration-handle-space" aria-hidden="true" />
        )}
        <Button
          type="button"
          variant="disclosure"
          className="configuration-select"
          aria-pressed={selected}
          onClick={onSelect}
        >
          <span className="configuration-service-label">
            <span title={serviceLabel(service)}>{serviceLabel(service)}</span>
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
      coordinateGetter: groupKeyboardCoordinates,
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
    const activeId = String(event.active.id);
    const targetGroup = PRIORITY_GROUPS.find(
      (group) => group === event.over!.data.current?.group,
    );
    if (!targetGroup) return;
    await persist(
      moveOwnedService(base.groups, activeId, targetGroup),
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
        <p className="configuration-status">
          Select a service to adjust Hold and Heartbeat.
        </p>
        <DndContext
          modifiers={orderModifiers}
          sensors={sensors}
          collisionDetection={groupCollision}
          accessibility={{
            announcements: {
              onDragStart: ({ active }) =>
                `Moving ${snapshot.services.find((s) => s.id === active.id)?.name ?? "service"} between groups.`,
              onDragOver: ({ active, over }) => {
                const group = over?.data.current?.group as
                  PriorityGroup | undefined;
                return group && group !== active.data.current?.group
                  ? `Move to ${priorityGroupLabels[group]}.`
                  : undefined;
              },
              onDragEnd: ({ active, over }) => {
                const group = over?.data.current?.group as
                  PriorityGroup | undefined;
                return group && group !== active.data.current?.group
                  ? `Moved to ${priorityGroupLabels[group]}.`
                  : "Priority group unchanged.";
              },
              onDragCancel: () => "Priority group move cancelled.",
            },
            screenReaderInstructions: {
              draggable:
                "Services within a group are equal. Press Space to pick up your service, use Up or Down to choose a group, then Space to save. You can also use the priority group menu.",
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
          <div
            ref={list}
            className="configuration-priority-groups"
            aria-label="Global service priority groups"
          >
            {groups.map((group) => {
              return (
                <PrioritySection
                  key={group.id}
                  group={group.id}
                  count={group.services.length}
                  pending={blocked}
                >
                  {deviceGroups(group.services).map((computer) => (
                    <div className="configuration-computer" key={computer.name}>
                      <div className="configuration-computer-heading">
                        {computer.name === ownerComputerId ? (
                          <Laptop aria-hidden="true" />
                        ) : (
                          <LockKeyhole aria-hidden="true" />
                        )}
                        <span
                          className="configuration-computer-id"
                          title={computer.name}
                        >
                          {computer.name.startsWith("service:")
                            ? "Unassigned"
                            : computer.name.slice(0, 8)}
                        </span>
                        <Badge variant="secondary">
                          {computer.name === ownerComputerId
                            ? "This computer"
                            : "Read only"}
                        </Badge>
                      </div>
                      {computer.services.map((service) => (
                        <ConfigurationRow
                          key={service.id}
                          service={service}
                          group={group.id}
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
                      ))}
                    </div>
                  ))}
                </PrioritySection>
              );
            })}
          </div>
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
