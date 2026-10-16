import { useState } from "react";
import { ChevronDown, LockKeyhole } from "lucide-react";
import type { Snapshot, Service } from "./api";
import { time } from "./api";
import { serviceRuntime } from "./service-runtime";
import { PriorityGroupBadge } from "./priority-group-badge";
import { serviceLabel } from "./service-layout";
import { cn } from "./lib/utils";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
import { Separator } from "./components/ui/separator";
import { SettingNumber } from "./setting-number";
import { MotionFeedback, MotionReveal } from "./motion";

/** Keep operational context visible; registration diagnostics are opt-in. */
export function ServiceDetails({
  snapshot,
  service,
  readOnly = false,
}: {
  snapshot: Snapshot;
  service: Service;
  readOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = serviceRuntime(snapshot, service);
  const bridges = [
    service.config.allowPreview && "Live preview",
    service.config.allowInput && "Bar buttons",
  ].filter(Boolean);
  return (
    <div className="service-runtime min-w-0" aria-label="Service runtime">
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            tabIndex={-1}
            className="max-w-full text-base font-semibold leading-snug [overflow-wrap:anywhere] outline-none"
          >
            {serviceLabel(service)}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>
              {service.template === "agent"
                ? "Agent status"
                : service.template === "notifier"
                  ? "Notifier"
                  : "Custom publisher"}
            </span>
            <PriorityGroupBadge group={status.priorityGroup} />
            {readOnly && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1">
                  <LockKeyhole className="size-3" aria-hidden="true" />
                  Read only
                </span>
              </>
            )}
          </div>
        </div>
        <Badge
          variant="ghost"
          aria-label={`Publisher ${status.connection.toLowerCase()}`}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full bg-muted-foreground",
              status.connection === "Online" && "bg-success",
              status.connection === "Offline" && "bg-destructive",
            )}
          />
          <MotionFeedback value={status.connection}>
            {status.connection}
          </MotionFeedback>
        </Badge>
      </header>
      <Collapsible open={expanded} onOpenChange={setExpanded} className="mt-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <MotionFeedback value={status.display}>
              {status.display}
            </MotionFeedback>
            {status.queued > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  <SettingNumber value={status.queued} /> queued
                </span>
              </>
            )}
            {status.paused > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  <SettingNumber value={status.paused} /> paused
                </span>
              </>
            )}
          </div>
          <CollapsibleTrigger
            render={<Button type="button" variant="disclosure" size="sm" />}
            className="group shrink-0"
          >
            Details
            <ChevronDown
              data-icon="inline-end"
              className="transition-transform duration-200 group-aria-expanded:rotate-180"
            />
          </CollapsibleTrigger>
        </div>
        {status.current && (
          <p
            className="mt-1 line-clamp-2 text-sm text-muted-foreground [overflow-wrap:anywhere]"
            title={status.current}
          >
            {status.current}
          </p>
        )}
        <CollapsibleContent className="motion-collapse">
          <MotionReveal className="pt-3">
            <dl className="grid min-w-0 grid-flow-dense grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2.5 text-xs">
              <dt className="text-muted-foreground">Service ID</dt>
              <dd className="min-w-0 select-all font-mono [overflow-wrap:anywhere]">
                {service.id}
              </dd>
              <dt className="text-muted-foreground">Computer ID</dt>
              <dd className="min-w-0 select-all font-mono [overflow-wrap:anywhere]">
                {service.computerId ?? "Not assigned"}
              </dd>
              <dt className="text-muted-foreground">Last heartbeat</dt>
              <dd className="min-w-0 tabular-nums">
                {status.lastHeartbeat === null
                  ? "Not received"
                  : time(status.lastHeartbeat)}
              </dd>
              <dt className="text-muted-foreground">Bridges</dt>
              <dd className="min-w-0">{bridges.join(" · ") || "None"}</dd>
            </dl>
          </MotionReveal>
        </CollapsibleContent>
      </Collapsible>
      <Separator className="my-4" />
    </div>
  );
}
