import { useState } from "react";
import { ChevronDown, LockKeyhole, Radio, Monitor } from "lucide-react";
import type { Snapshot, Service } from "./api";
import { time } from "./api";
import { serviceRuntime } from "./service-runtime";
import { PriorityGroupBadge } from "./priority-group-badge";
import { serviceLabel } from "./service-layout";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
import { SettingNumber } from "./setting-number";
import { MotionFeedback, MotionReveal } from "./motion";
import { MetadataTile } from "./metadata-tiles";

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
  return (
    <div className="service-runtime" aria-label="Service runtime">
      <header className="runtime-heading">
        <div className="min-w-0">
          <h2 tabIndex={-1}>{serviceLabel(service)}</h2>
          <p>
            {service.template === "agent"
              ? "Agent status"
              : service.template === "notifier"
                ? "Notifications"
                : "Custom publisher"}
          </p>
        </div>
        <PriorityGroupBadge group={status.priorityGroup} />
      </header>
      {readOnly && (
        <p className="runtime-readonly">
          <LockKeyhole aria-hidden="true" /> Managed on{" "}
          {service.computerId?.slice(0, 8) ?? "another computer"}
        </p>
      )}
      <div className="metadata-grid runtime-bento">
        <MetadataTile
          label="Publisher"
          className="publisher-tile"
          detail={
            status.lastHeartbeat === null ? (
              "Waiting for its first heartbeat"
            ) : (
              <>Last seen {time(status.lastHeartbeat)}</>
            )
          }
        >
          <Radio aria-hidden="true" />
          <MotionFeedback value={status.connection}>
            {status.connection}
          </MotionFeedback>
        </MetadataTile>
        <MetadataTile
          label="On the Bar"
          detail={status.current ?? "No active display"}
        >
          <Monitor aria-hidden="true" />
          <MotionFeedback value={status.display}>
            {status.display}
          </MotionFeedback>
        </MetadataTile>
        {(status.queued > 0 || status.paused > 0) && (
          <div className="runtime-queue-note">
            {status.queued > 0 && (
              <span>
                <SettingNumber value={status.queued} /> waiting
              </span>
            )}
            {status.paused > 0 && (
              <span>
                <SettingNumber value={status.paused} /> paused
              </span>
            )}
          </div>
        )}
      </div>
      <Collapsible
        open={expanded}
        onOpenChange={setExpanded}
        className="runtime-identity"
      >
        <CollapsibleTrigger
          render={<Button type="button" variant="disclosure" size="sm" />}
        >
          Connection details <ChevronDown data-icon="inline-end" />
        </CollapsibleTrigger>
        <CollapsibleContent className="motion-collapse">
          <MotionReveal className="metadata-grid runtime-identities">
            {status.current && (
              <p className="runtime-full-title">{status.current}</p>
            )}
            <MetadataTile label="Service ID">
              <code>{service.id}</code>
            </MetadataTile>
            <MetadataTile label="Computer ID">
              <code>{service.computerId ?? "Not assigned"}</code>
            </MetadataTile>
            <div className="runtime-capabilities">
              <Badge variant="secondary">
                {service.config.allowInput
                  ? "Bar buttons on"
                  : "Bar buttons off"}
              </Badge>
              <Badge variant="secondary">
                {service.config.allowPreview
                  ? "Live preview on"
                  : "Live preview off"}
              </Badge>
            </div>
          </MotionReveal>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
