import { useEffect, useState } from "react";
import { api, time } from "./api";
import type { Mutate, Snapshot } from "./api";
import { Icon, serviceName } from "./common";
import type { IconName } from "./common";
import { ServiceEditor, Register } from "./services";
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
        <button
          key={entry.id}
          className={page === entry.id ? "selected" : ""}
          aria-current={page === entry.id ? "page" : undefined}
          onClick={() => onPage(entry.id)}
        >
          <Icon name={entry.icon} />
          <span>{entry.label}</span>
        </button>
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
  return (
    <section className="management-page" aria-labelledby="services-title">
      <div className="page-heading">
        <h1 id="services-title">Services</h1>
        <button
          className="primary"
          onClick={() => setRegister((value) => !value)}
        >
          <Icon name="plus" />
          {register ? "Cancel" : "Register"}
        </button>
      </div>
      {register && (
        <Register
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
        {snapshot.services.map((service) => (
          <ServiceEditor
            mode="access"
            key={service.id}
            service={service}
            configRevision={snapshot.configRevision}
            mutate={mutate}
            pending={pending}
            onCredential={onCredential}
          />
        ))}
      </div>
      {!snapshot.services.length && (
        <p className="empty-state">
          Register a service to connect a local collector.
        </p>
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
        <p className="empty-state">
          Add a service in Services to configure its display rules.
        </p>
      )}
      <div className="service-list">
        {snapshot.services.map((service) => (
          <ServiceEditor
            key={service.id}
            service={service}
            configRevision={snapshot.configRevision}
            mutate={mutate}
            pending={pending}
            onCredential={onCredential}
          />
        ))}
      </div>
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
        <button onClick={onRefresh}>
          <Icon name="refresh" />
          Refresh
        </button>
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
        Preview runs while Display is visible. A Mac must be online and able to
        read the Bar over local Wi-Fi. Latency uses the Mac and browser clocks.
      </p>
      <button className="text-button signout" onClick={onLogout}>
        Sign out
      </button>
    </section>
  );
}
