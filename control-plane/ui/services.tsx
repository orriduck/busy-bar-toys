import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Service, Mutate } from "./api";
export function ServiceEditor({
  service,
  configRevision,
  mutate,
  pending,
  onCredential,
  mode = "policy",
}: {
  service: Service;
  mode?: "policy" | "access";
  configRevision: number;
  mutate: Mutate;
  pending: boolean;
  onCredential: (value: {
    credential: string;
    epoch: string;
    epochExpiresAt: number;
    id: string;
  }) => void;
}) {
  const [config, setConfig] = useState(service.config);
  const [dirty, setDirty] = useState(false);
  const edits = useRef(0);
  const [baseRevision, setBaseRevision] = useState(configRevision);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  useEffect(() => {
    if (!dirty) {
      setConfig(service.config);
      setBaseRevision(configRevision);
    }
  }, [service.config, configRevision, dirty]);
  const edit = (key: string, value: unknown) => {
    edits.current++;
    setConfig((previous) => ({ ...previous, [key]: value }));
    setDirty(true);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const submittedEdit = edits.current;
    const result = await mutate(
      `/services/${encodeURIComponent(service.id)}`,
      { expectedRevision: baseRevision, config },
      "PATCH",
    );
    if (result) {
      if (edits.current === submittedEdit) setDirty(false);
      else {
        const state = result.snapshot as
          { configRevision?: number } | undefined;
        if (typeof state?.configRevision === "number")
          setBaseRevision(state.configRevision);
      }
    }
  };
  const rotate = async () => {
    const result = await mutate(
      `/services/${encodeURIComponent(service.id)}/credential`,
      { expectedRevision: configRevision },
    );
    if (result)
      onCredential({
        credential: String(result.credential),
        epoch: String(result.epoch),
        epochExpiresAt: Number(result.epochExpiresAt),
        id: service.id,
      });
  };
  if (mode === "access")
    return (
      <section className="service service-access">
        <div className="service-top">
          <div>
            <h3>{service.name}</h3>
            <span className="muted">
              {service.template} · {service.id}
            </span>
          </div>
        </div>
        <p className="muted">
          Publisher expires{" "}
          {new Date(service.epochExpiresAt).toLocaleDateString()}.
        </p>
        <div className="access-actions">
          <button
            type="button"
            disabled={pending}
            onClick={() => void rotate()}
          >
            Replace credential
          </button>
          {confirmRevoke ? (
            <>
              <span>End this service’s queued items and revoke access?</span>
              <button
                type="button"
                className="danger"
                disabled={pending}
                onClick={() =>
                  void mutate(
                    `/services/${encodeURIComponent(service.id)}/revoke`,
                    { expectedRevision: configRevision },
                  )
                }
              >
                Confirm revoke
              </button>
              <button type="button" onClick={() => setConfirmRevoke(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="text-button"
              onClick={() => setConfirmRevoke(true)}
            >
              Revoke service
            </button>
          )}
        </div>
      </section>
    );
  return (
    <form className="service" onSubmit={(event) => void save(event)}>
      <div className="service-top">
        <div>
          <h3>{service.name}</h3>
          <span className="muted">
            {service.template} · {service.id}
          </span>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={config.enabled}
            aria-label={`Enable ${service.name}`}
            onChange={(event) => edit("enabled", event.target.checked)}
          />
          <span />
        </label>
      </div>
      <div className="service-fields">
        <label>
          Priority
          <input
            type="number"
            required
            min="0"
            max="1000"
            value={config.priority}
            onChange={(event) => edit("priority", Number(event.target.value))}
          />
        </label>
        <label>
          Exit
          <select
            value={config.exit}
            onChange={(event) => edit("exit", event.target.value)}
          >
            <option value="default">Automatic</option>
            <option value="finite">Fixed time</option>
            <option value="source">Source ends</option>
          </select>
        </label>
        <label>
          Hold (s)
          <input
            type="number"
            required
            min="1"
            step="any"
            max="86400"
            value={config.visibleMs / 1000}
            onChange={(event) =>
              edit("visibleMs", Math.round(Number(event.target.value) * 1000))
            }
          />
        </label>
        <label>
          Later (min)
          <input
            type="number"
            required
            min="0.016666666666666666"
            step="any"
            max="1440"
            value={config.snoozeMs / 60000}
            onChange={(event) =>
              edit("snoozeMs", Math.round(Number(event.target.value) * 60000))
            }
          />
        </label>
        <label>
          Heartbeat (s)
          <input
            type="number"
            required
            min="5"
            step="any"
            max="300"
            value={config.heartbeatMs / 1000}
            onChange={(event) =>
              edit("heartbeatMs", Math.round(Number(event.target.value) * 1000))
            }
          />
        </label>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={"allowInput" in config && Boolean(config.allowInput)}
          onChange={(event) => edit("allowInput", event.target.checked)}
        />
        Trusted device button bridge
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={config.allowPreview === true}
          onChange={(event) => edit("allowPreview", event.target.checked)}
        />
        Live display preview bridge
      </label>
      <p className="field-hint">
        Use one Mac with local Wi-Fi access to the Bar.
      </p>
      {dirty && baseRevision !== configRevision && (
        <p className="inline-warning">
          Configuration changed elsewhere. Reload this form before saving.
        </p>
      )}
      <div className="service-bottom">
        <button className="save" disabled={pending || !dirty}>
          Save{dirty ? " changes" : ""}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setDirty(false);
              setConfig(service.config);
              setBaseRevision(configRevision);
            }}
          >
            Reload
          </button>
        )}
      </div>
    </form>
  );
}
export function Register({
  revision,
  mutate,
  pending,
  onCreated,
}: {
  revision: number;
  mutate: Mutate;
  pending: boolean;
  onCreated: (value: {
    credential: string;
    epoch: string;
    epochExpiresAt: number;
    id: string;
  }) => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("agent");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await mutate("/services", {
      id,
      name,
      template,
      expectedRevision: revision,
      config: { priority: template === "agent" ? 10 : 50 },
    });
    if (result)
      onCreated({
        id,
        credential: String(result.credential),
        epoch: String(result.epoch),
        epochExpiresAt: Number(result.epochExpiresAt),
      });
  };
  return (
    <form className="register" onSubmit={(event) => void submit(event)}>
      <h3>Register a service</h3>
      <label>
        Name
        <input
          required
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="My Codex"
        />
      </label>
      <label>
        Service ID
        <input
          required
          pattern="[A-Za-z0-9_-]{1,64}"
          maxLength={64}
          value={id}
          onChange={(event) => setId(event.target.value)}
          placeholder="codex-mac"
        />
      </label>
      <label>
        Template
        <select
          value={template}
          onChange={(event) => setTemplate(event.target.value)}
        >
          <option value="agent">Agent checker</option>
          <option value="notifier">Notifier</option>
          <option value="custom">Custom publisher</option>
        </select>
      </label>
      <button className="primary" disabled={pending}>
        Create service
      </button>
    </form>
  );
}
