import { useEffect, useRef, useState } from "react";
import { api, time } from "./api";
import type { Mutate, Snapshot, Service } from "./api";
import { Icon, serviceName } from "./common";
import { Button } from "./components/ui/button";
import { Empty, EmptyHeader, EmptyDescription } from "./components/ui/empty";
import { ServiceEditor, Register } from "./services";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "./components/ui/card";
import { ItemGroup } from "./components/ui/item";
import { Separator } from "./components/ui/separator";
import { Badge } from "./components/ui/badge";
import { ComputerAccess } from "./computer-access";
import { orderedDeviceGroups } from "./service-layout";
import { ConfigurationList } from "./configuration";
import type { PreviewStatus } from "./preview-session";
import type { PreviewStats } from "./preview";
import { MotionFeedback, MotionReveal, useListMotion } from "./motion";
import { SettingNumber } from "./setting-number";
import { InstallApp } from "./pwa";
import { Check, Copy, ChevronDown, Radio } from "lucide-react";
import { Input } from "./components/ui/input";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./components/ui/collapsible";
import { sourceRouteCommand } from "./service-setup";
export { Navigation } from "./navigation";
export type { Page } from "./navigation";
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
  ownerComputerId,
  onPaired,
}: {
  ownerComputerId: string | null;
  onPaired: (id: string) => void;
  snapshot: Snapshot;
  mutate: Mutate;
  pending: boolean;
  onCredential: (value: CredentialValue) => void;
}) {
  const [register, setRegister] = useState(false);
  const [registeredId, setRegisteredId] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const groups = orderedDeviceGroups(snapshot).sort(
    (a, b) =>
      Number(b.name === ownerComputerId) - Number(a.name === ownerComputerId),
  );
  const own = snapshot.services.filter(
    (service) => service.computerId === ownerComputerId,
  );
  const [guideOpen, setGuideOpen] = useState(true);
  const addRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (register)
      addRef.current
        ?.querySelector<HTMLButtonElement>('[data-slot="toggle-group-item"]')
        ?.focus({ preventScroll: true });
  }, [register]);
  useListMotion(
    list,
    JSON.stringify(groups.map((group) => group.name)),
    false,
    "[data-motion-group]",
  );
  return (
    <section className="management-page" aria-labelledby="services-title">
      <div className="page-heading">
        <h1 id="services-title">Services</h1>
        <Button
          disabled={!ownerComputerId}
          onClick={() => {
            if (!register) setRegisteredId(null);
            setRegister((value) => !value);
          }}
        >
          <Icon name={register ? "end" : "plus"} data-icon="inline-start" />
          {register ? "Cancel" : "Add service"}
        </Button>
      </div>
      <p className="services-lede">
        Your apps, one small screen. Choose what gets a place on your Bar.
      </p>
      {!ownerComputerId && (
        <ComputerAccess
          ownerComputerId={ownerComputerId}
          mutate={mutate}
          pending={pending}
          onPaired={onPaired}
        />
      )}
      <Collapsible
        open={guideOpen}
        onOpenChange={setGuideOpen}
        className="services-setup-guide"
      >
        <CollapsibleTrigger
          render={<Button type="button" variant="disclosure" size="sm" />}
        >
          Getting started <ChevronDown data-icon="inline-end" />
        </CollapsibleTrigger>
        <CollapsibleContent className="motion-collapse">
          <div className="setup-steps">
            <div data-complete={!!ownerComputerId}>
              <span>
                {ownerComputerId ? <Check /> : <Icon name="computer" />}
              </span>
              <div>
                <strong>Connect this computer</strong>
                <p>
                  {ownerComputerId
                    ? "Paired. You can manage its services here."
                    : "Use Connect computer above to pair this browser."}
                </p>
              </div>
            </div>
            <div data-complete={own.length > 0}>
              <span>{own.length > 0 ? <Check /> : <Icon name="plus" />}</span>
              <div>
                <strong>Add something to display</strong>
                <p>Agent status, notifications or your own app.</p>
              </div>
            </div>
            <div
              data-complete={own.some(
                (service) =>
                  service.lastHeartbeatAt !== null &&
                  service.lastHeartbeatAt !== undefined,
              )}
            >
              <span>
                <Radio />
              </span>
              <div>
                <strong>Connect its sender</strong>
                <p>Route a local source. Its card shows when it checks in.</p>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
      {register && ownerComputerId && (
        <div ref={addRef}>
          <MotionReveal>
            <Register
              computerId={ownerComputerId}
              revision={snapshot.configRevision}
              mutate={mutate}
              pending={pending}
              onCreated={(value) => {
                setRegisteredId(value.id);
                setRegister(false);
              }}
            />
          </MotionReveal>
        </div>
      )}
      {registeredId && (
        <SourceConnection
          id={registeredId}
          service={snapshot.services.find(
            (service) => service.id === registeredId,
          )}
          onDismiss={() => setRegisteredId(null)}
        />
      )}
      <div ref={list} className="service-list">
        {groups.map((group) => (
          <Card
            role="region"
            className="device-service-group gap-0 overflow-hidden p-0"
            key={group.name}
            data-motion-group={group.name}
            aria-label={`${group.name} services`}
          >
            <CardHeader className="device-group-heading bg-muted/50">
              <Icon name="computer" />
              <CardTitle className="min-w-0 flex-1">
                <h2 title={group.name}>
                  {group.name.startsWith("service:")
                    ? "Unassigned"
                    : group.name.slice(0, 8)}
                </h2>
              </CardTitle>
              {ownerComputerId === group.name && (
                <Badge variant="secondary" className="this-computer-badge">
                  This computer
                </Badge>
              )}
              <span className="device-service-count">
                <SettingNumber value={group.services.length} />{" "}
                {group.services.length === 1 ? "service" : "services"}
              </span>
              {ownerComputerId !== group.name && (
                <Badge variant="outline">Read only</Badge>
              )}
            </CardHeader>
            <Separator />
            <CardContent className="p-0">
              <ServiceRows
                readOnly={group.name !== ownerComputerId}
                services={group.services}
                snapshot={snapshot}
                mutate={mutate}
                pending={pending}
                onCredential={onCredential}
              />
            </CardContent>
          </Card>
        ))}
      </div>
      {!snapshot.services.length && (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>
              Add your first service, then connect the app that will send to it.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </section>
  );
}
function ServiceRows({
  readOnly,
  services,
  snapshot,
  mutate,
  pending,
  onCredential,
}: {
  readOnly: boolean;
  services: Service[];
  snapshot: Snapshot;
  mutate: Mutate;
  pending: boolean;
  onCredential: (value: CredentialValue) => void;
}) {
  const scope = useRef<HTMLDivElement>(null);
  useListMotion(scope, JSON.stringify(services.map((service) => service.id)));
  return (
    <ItemGroup ref={scope} className="service-card-grid">
      {services.map((service) => (
        <ServiceEditor
          key={service.id}
          readOnly={readOnly}
          mode="access"
          service={service}
          snapshot={snapshot}
          configRevision={snapshot.configRevision}
          mutate={mutate}
          pending={pending}
          onCredential={onCredential}
        />
      ))}
    </ItemGroup>
  );
}
function SourceConnection({
  id,
  service,
  onDismiss,
}: {
  id: string;
  service?: Service;
  onDismiss: () => void;
}) {
  const [source, setSource] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const command = sourceRouteCommand(source, id);
  const fieldId = `route-${id}`;
  return (
    <Card className="source-connect-card" size="sm">
      <CardHeader>
        <CardTitle>{service?.name ?? "Service"} added</CardTitle>
        <CardDescription>
          Run this on the computer that sends its updates. Use your local source
          name, for example codex or github.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field data-invalid={!!source && !command}>
            <FieldLabel htmlFor={fieldId}>Local source name</FieldLabel>
            <Input
              id={fieldId}
              autoFocus
              maxLength={64}
              aria-invalid={!!source && !command}
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setCopied(false);
                setCopyError(false);
              }}
              placeholder="e.g. codex"
            />
          </Field>
        </FieldGroup>
        {command && (
          <div className="source-route-command">
            <code>{command}</code>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Copy route command"
              onClick={() => {
                void navigator.clipboard
                  .writeText(command)
                  .then(() => setCopied(true))
                  .catch(() => setCopyError(true));
              }}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
        )}
        <p className="source-route-status" role="status">
          {source && !command
            ? "Use 1–64 letters, numbers, underscores or hyphens. Reserved names are unavailable."
            : copyError
              ? "Copy is unavailable. Select the command to copy it."
              : copied
                ? "Copied. Run it in your terminal."
                : service?.lastHeartbeatAt
                  ? "The sender has checked in."
                  : "The card below will show Online after its first heartbeat."}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          Done
        </Button>
      </CardContent>
    </Card>
  );
}

export function ConfigurationPage({
  snapshot,
  mutate,
  pending,
  onCredential,
  ownerComputerId,
  onPaired,
}: {
  ownerComputerId: string | null;
  onPaired: (id: string) => void;
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
      <ComputerAccess
        ownerComputerId={ownerComputerId}
        mutate={mutate}
        pending={pending}
        onPaired={onPaired}
      />
      <p className="configuration-hint">
        Three shared priorities. Drag your services to change groups.
      </p>
      <ConfigurationList
        ownerComputerId={ownerComputerId}
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
  const controller =
    owner && snapshot.health.status === "healthy"
      ? serviceName(snapshot, owner.serviceId)
      : selected
        ? `${serviceName(snapshot, selected.serviceId)} · awaiting confirmation`
        : "Native calendar";
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
        <dd>
          <MotionFeedback value={stream}>
            {stream === "Live" ? "Connected" : stream}
          </MotionFeedback>
        </dd>
        <dt>Device status</dt>
        <dd>
          <MotionFeedback value={snapshot.health.status}>
            {snapshot.health.status}
          </MotionFeedback>
        </dd>
        <dt>Current controller</dt>
        <dd>
          <MotionFeedback value={controller}>{controller}</MotionFeedback>
        </dd>
        <dt>Last API confirmation</dt>
        <dd>{time(snapshot.health.lastSuccessAt)}</dd>
        <dt>Last synchronized</dt>
        <dd>{time(lastSync)}</dd>
        <dt>Identity</dt>
        <dd className="device-identity">{snapshot.deviceId}</dd>
        <dt>Configuration</dt>
        <dd>
          Revision <SettingNumber value={snapshot.configRevision} />
        </dd>
      </dl>
      <h2>Live preview</h2>
      <dl className="device-facts">
        <dt>Capture bridge</dt>
        <dd>
          <MotionFeedback
            value={`${previewError}:${preview?.connected}:${preview?.serviceId ?? ""}`}
          >
            {previewError
              ? "Unavailable"
              : preview?.connected && preview.serviceId
                ? serviceName(snapshot, preview.serviceId)
                : "Not connected"}
          </MotionFeedback>
        </dd>
        <dt>Instance</dt>
        <dd>{preview?.instanceId || "—"}</dd>
        <dt>Viewers</dt>
        <dd>
          {typeof preview?.viewers === "number" ? (
            <SettingNumber value={preview.viewers} />
          ) : (
            "—"
          )}
        </dd>
        <dt>Current received rate</dt>
        <dd>
          {typeof preview?.acceptedFps === "number" ? (
            <>
              <SettingNumber
                value={preview.acceptedFps}
                decimals={1}
                minimumDecimals={1}
              />{" "}
              fps
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt>Last browser sample</dt>
        <dd>
          {sample ? (
            <>
              <SettingNumber
                value={sample.receivedFps}
                decimals={1}
                minimumDecimals={1}
              />{" "}
              received /{" "}
              <SettingNumber
                value={sample.drawnFps}
                decimals={1}
                minimumDecimals={1}
              />{" "}
              drawn fps
            </>
          ) : (
            "—"
          )}
        </dd>
        <dt>Last frame</dt>
        <dd>{time(preview?.lastFrameAt)}</dd>
        <dt>Last browser latency</dt>
        <dd>
          {sample?.latencyMs === null || sample?.latencyMs === undefined ? (
            "—"
          ) : (
            <>
              <SettingNumber value={Math.round(sample.latencyMs)} /> ms
            </>
          )}
        </dd>
      </dl>
      <p className="field-hint">
        Preview runs on every visible management page: above the queue on
        Display and in the preview dock elsewhere. A Mac must be online and able
        to read the Bar over local Wi-Fi. Latency includes the 150 ms playback
        buffer and uses the Mac and browser clocks.
      </p>
      <InstallApp />
      <Button variant="destructive" className="signout" onClick={onLogout}>
        Sign out
      </Button>
    </section>
  );
}
