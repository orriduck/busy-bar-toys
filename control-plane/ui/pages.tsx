import { Fragment, useEffect, useState } from "react";
import { api, time } from "./api";
import type { Mutate, Snapshot } from "./api";
import { Icon, serviceName } from "./common";
import { Button } from "./components/ui/button";
import { Empty, EmptyHeader, EmptyDescription } from "./components/ui/empty";
import { cn } from "./lib/utils";
import type { IconName } from "./common";
import { ServiceEditor, Register } from "./services";
import { Card, CardHeader, CardTitle, CardContent } from "./components/ui/card";
import { ItemGroup, ItemSeparator } from "./components/ui/item";
import { Separator } from "./components/ui/separator";
import { Badge } from "./components/ui/badge";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
} from "./components/ui/dropdown-menu";
import { useComputerBinding } from "./computer-binding";
import { deviceGroups } from "./service-layout";
import { ConfigurationList } from "./configuration";
import type { PreviewStatus } from "./preview-session";
import type { PreviewStats } from "./preview";
export type Page = "display" | "services" | "configuration" | "device";
const pages: { id: Page; label: string; icon: IconName }[] = [
  { id: "display", label: "Display", icon: "display" },
  { id: "services", label: "Services", icon: "services" },
  { id: "configuration", label: "Configuration", icon: "settings" },
  { id: "device", label: "Device", icon: "device" },
];
export function Navigation({
  page,
  onPage,
}: {
  page: Page;
  onPage: (page: Page) => void;
}) {
  return (
    <nav aria-label="Control plane">
      {pages.map((entry) => (
        <Button
          key={entry.id}
          variant="navigation"
          className={cn("w-full", page === entry.id && "selected")}
          aria-current={page === entry.id ? "page" : undefined}
          onClick={() => onPage(entry.id)}
        >
          <Icon name={entry.icon} data-icon="inline-start" />
          <span>{entry.label}</span>
        </Button>
      ))}
    </nav>
  );
}
export type CredentialValue = {
  credential: string;
  epoch: string;
  epochExpiresAt: number;
  id: string;
};
export function ServicesPage({
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
  const [register, setRegister] = useState(false);
  const [thisComputer, bindComputer] = useComputerBinding(
    snapshot.deviceId,
    snapshot.services,
    snapshot.items,
  );
  return (
    <section className="management-page" aria-labelledby="services-title">
      <div className="page-heading">
        <h1 id="services-title">Services</h1>
        <Button onClick={() => setRegister((value) => !value)}>
          <Icon name="plus" data-icon="inline-start" />
          {register ? "Cancel" : "Register"}
        </Button>
      </div>
      {register && (
        <Register
          services={snapshot.services}
          revision={snapshot.configRevision}
          mutate={mutate}
          pending={pending}
          onCreated={(value) => {
            onCredential(value);
            setRegister(false);
          }}
        />
      )}
      <div className="service-list">
        {deviceGroups(snapshot.services, snapshot.items).map((group) => (
          <Card
            role="region"
            className="device-service-group gap-0 overflow-hidden p-0"
            key={group.name}
            aria-label={`${group.name} services`}
          >
            <CardHeader className="device-group-heading bg-muted/50">
              <Icon name="computer" />
              <CardTitle className="min-w-0 flex-1">
                <h2 title={group.name}>
                  {group.name.startsWith("service:")
                    ? group.name.slice(8)
                    : group.name}
                </h2>
              </CardTitle>
              {thisComputer === group.name && (
                <Badge variant="secondary" className="this-computer-badge">
                  This computer
                </Badge>
              )}
              <span className="device-service-count">
                {group.services.length}{" "}
                {group.services.length === 1 ? "service" : "services"}
              </span>
              {!group.name.startsWith("service:") && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Computer actions for ${group.name}`}
                      />
                    }
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        onClick={() =>
                          bindComputer(
                            thisComputer === group.name ? null : group.name,
                          )
                        }
                      >
                        {thisComputer === group.name
                          ? "Clear this computer"
                          : "Use as this computer"}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </CardHeader>
            <Separator />
            <CardContent className="p-0">
              <ItemGroup className="gap-0 has-data-[size=sm]:gap-0">
                {group.services.map((service, index) => (
                  <Fragment key={service.id}>
                    {index > 0 && (
                      <ItemSeparator className="my-0" aria-hidden="true" />
                    )}
                    <ServiceEditor
                      mode="access"
                      key={service.id}
                      service={service}
                      configRevision={snapshot.configRevision}
                      mutate={mutate}
                      pending={pending}
                      onCredential={onCredential}
                    />
                  </Fragment>
                ))}
              </ItemGroup>
            </CardContent>
          </Card>
        ))}
      </div>
      {!snapshot.services.length && (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>
              Register a service to connect a local collector.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </section>
  );
}
export function ConfigurationPage({
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
  return (
    <section className="management-page" aria-labelledby="configuration-title">
      <div className="page-heading">
        <h1 id="configuration-title">Configuration</h1>
      </div>
      {!snapshot.services.length && (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>
              Add a service in Services to configure its display rules.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <p className="configuration-hint">
        Drag to set priority. Higher services play first within the same
        urgency. Click a service for detailed settings.
      </p>
      <ConfigurationList
        snapshot={snapshot}
        mutate={mutate}
        pending={pending}
        onCredential={onCredential}
      />
    </section>
  );
}
export function DevicePage({
  snapshot,
  active,
  stream,
  lastSync,
  stats,
  onRefresh,
  onLogout,
}: {
  snapshot: Snapshot;
  active: boolean;
  stream: string;
  lastSync?: number;
  stats: PreviewStats | null;
  onRefresh: () => void;
  onLogout: () => void;
}) {
  const [preview, setPreview] = useState<PreviewStatus | null>(null);
  const [previewError, setPreviewError] = useState(false);
  useEffect(() => {
    if (!active) return;
    let current = true;
    const read = () =>
      void api<PreviewStatus>(
        "/preview/status",
        undefined,
        "GET",
        snapshot.deviceId,
      )
        .then((value) => {
          if (current && value.deviceId === snapshot.deviceId) {
            setPreview(value);
            setPreviewError(false);
          }
        })
        .catch(() => {
          if (current) setPreviewError(true);
        });
    read();
    const timer = setInterval(read, 5000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [active, snapshot.deviceId]);
  const owner = snapshot.items.find(
    (item) => item.itemKey === snapshot.displaying?.itemKey,
  );
  const selected = snapshot.items.find(
    (item) => item.itemKey === snapshot.selected,
  );
  const sample = stats?.deviceId === snapshot.deviceId ? stats : null;
  return (
    <section className="management-page" aria-labelledby="device-title">
      <div className="page-heading">
        <h1 id="device-title">Device</h1>
        <Button variant="secondary" onClick={onRefresh}>
          <Icon name="refresh" data-icon="inline-start" />
          Refresh
        </Button>
      </div>
      <dl className="device-facts">
        <dt>Connection</dt>
        <dd>{stream === "Live" ? "Connected" : stream}</dd>
        <dt>Device status</dt>
        <dd>{snapshot.health.status}</dd>
        <dt>Current controller</dt>
        <dd>
          {owner && snapshot.health.status === "healthy"
            ? serviceName(snapshot, owner.serviceId)
            : selected
              ? `${serviceName(snapshot, selected.serviceId)} · awaiting confirmation`
              : "Native calendar"}
        </dd>
        <dt>Last API confirmation</dt>
        <dd>{time(snapshot.health.lastSuccessAt)}</dd>
        <dt>Last synchronized</dt>
        <dd>{time(lastSync)}</dd>
        <dt>Identity</dt>
        <dd className="device-identity">{snapshot.deviceId}</dd>
        <dt>Configuration</dt>
        <dd>Revision {snapshot.configRevision}</dd>
      </dl>
      <h2>Live preview</h2>
      <dl className="device-facts">
        <dt>Capture bridge</dt>
        <dd>
          {previewError
            ? "Unavailable"
            : preview?.connected && preview.serviceId
              ? serviceName(snapshot, preview.serviceId)
              : "Not connected"}
        </dd>
        <dt>Instance</dt>
        <dd>{preview?.instanceId || "—"}</dd>
        <dt>Viewers</dt>
        <dd>{preview?.viewers ?? "—"}</dd>
        <dt>Current received rate</dt>
        <dd>{preview?.acceptedFps ?? 0} fps</dd>
        <dt>Last browser sample</dt>
        <dd>
          {sample
            ? `${sample.receivedFps.toFixed(1)} received / ${sample.drawnFps.toFixed(1)} drawn fps`
            : "—"}
        </dd>
        <dt>Last frame</dt>
        <dd>{time(preview?.lastFrameAt)}</dd>
        <dt>Last browser latency</dt>
        <dd>
          {sample?.latencyMs === null || sample?.latencyMs === undefined
            ? "—"
            : `${Math.round(sample.latencyMs)} ms`}
        </dd>
      </dl>
      <p className="field-hint">
        Preview runs on every visible management page: above the queue on
        Display and in the preview dock elsewhere. A Mac must be online and able
        to read the Bar over local Wi-Fi. Latency includes the 150 ms playback
        buffer and uses the Mac and browser clocks.
      </p>
      <Button variant="destructive" className="signout" onClick={onLogout}>
        Sign out
      </Button>
    </section>
  );
}
