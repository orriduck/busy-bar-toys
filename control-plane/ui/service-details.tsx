import type { Snapshot, Service } from "./api";
import { time } from "./api";
import { serviceRuntime } from "./service-runtime";
import { Badge } from "./components/ui/badge";
import { SettingNumber } from "./setting-number";
export function ServiceDetails({
  snapshot,
  service,
}: {
  snapshot: Snapshot;
  service: Service;
}) {
  const status = serviceRuntime(snapshot, service);
  return (
    <div className="service-runtime" aria-label="Service runtime">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant="secondary">{status.connection}</Badge>
        <span className="text-sm text-muted-foreground">
          {service.template === "agent"
            ? "Agent status"
            : service.template === "notifier"
              ? "Notifier"
              : "Custom publisher"}
        </span>
        {status.tier !== null && (
          <Badge
            variant="outline"
            title="Position is a global priority tier across computers. Smaller wins; equal tiers rotate by Hold."
          >
            Tier <SettingNumber value={status.tier} />
          </Badge>
        )}
      </div>
      <dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-5 gap-y-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Display</dt>
          <dd className="mt-1">{status.display}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Queued</dt>
          <dd className="mt-1">
            <SettingNumber value={status.queued} />
            {status.paused > 0 && (
              <>
                {" "}
                · <SettingNumber value={status.paused} /> paused
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last heartbeat</dt>
          <dd className="mt-1 tabular-nums">{time(status.lastHeartbeat)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Capabilities</dt>
          <dd className="mt-1">
            {[
              service.config.allowPreview && "Preview",
              service.config.allowInput && "Bar buttons",
            ]
              .filter(Boolean)
              .join(" · ") || "Publisher only"}
          </dd>
        </div>
        <div className="col-span-2 min-w-0">
          <dt className="text-muted-foreground">Computer</dt>
          <dd className="mt-1 break-all font-mono text-xs">
            {service.computerId ?? "Not assigned"}
          </dd>
        </div>
        {status.current && (
          <div className="col-span-2 min-w-0">
            <dt className="text-muted-foreground">Current message</dt>
            <dd className="mt-1 break-words">{status.current}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
