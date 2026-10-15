import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, APIError, time, message } from "./api";
import type { Snapshot, Mutate } from "./api";
import { Brand, Icon, Meta, serviceName } from "./common";
import { SignIn, Credential } from "./auth";
import { Queue } from "./queue";
import { ServiceEditor, Register } from "./services";
import { SessionFence, collectorSetupMode } from "./session";
import "./style.css";
function App() {
  const [session, setSession] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [demo, setDemo] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [stream, setStream] = useState("Connecting");
  const [lastSync, setLastSync] = useState<number>();
  const [pending, setPending] = useState(false);
  const [register, setRegister] = useState(false);
  const [secret, setSecret] = useState<{
    credential: string;
    epoch: string;
    epochExpiresAt: number;
    id: string;
  } | null>(null);
  const fence = useRef(new SessionFence());
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const eventSource = useRef<EventSource | null>(null);
  const clearSession = useCallback((deviceId: string | null) => {
    const generation = fence.current.reset(deviceId);
    setSessionGeneration(generation);
    eventSource.current?.close();
    eventSource.current = null;
    setSnapshot(null);
    setSecret(null);
    setRegister(false);
    setPending(false);
    setLastSync(undefined);
    setStream("Connecting");
    return generation;
  }, []);
  const beginSession = useCallback(
    (deviceId: string, serverDemo: boolean | undefined) => {
      if (!/^[a-f0-9]{64}$/.test(deviceId)) {
        clearSession(null);
        setSession(false);
        setError("The device identity could not be verified.");
        return;
      }
      clearSession(deviceId);
      setDemo(typeof serverDemo === "boolean" ? serverDemo : null);
      setError("");
      setSession(true);
    },
    [clearSession],
  );
  const invalidate = useCallback(() => {
    clearSession(null);
    setSession(false);
  }, [clearSession]);
  const apply = useCallback(
    (value: Snapshot, generation: number) => {
      if (!fence.current.current(generation)) return false;
      if (
        !value ||
        value.protocol !== 1 ||
        !Array.isArray(value.items) ||
        !Array.isArray(value.services)
      )
        return false;
      if (value.deviceId !== fence.current.deviceId) {
        invalidate();
        setError("The device session changed in another page. Sign in again.");
        return false;
      }
      if (!fence.current.accept(value.deviceId, value.revision, generation))
        return false;
      setSnapshot(value);
      setLastSync(Date.now());
      return true;
    },
    [invalidate],
  );
  const refresh = useCallback(async () => {
    const generation = fence.current.generation;
    try {
      apply(await api<Snapshot>("/snapshot"), generation);
    } catch (e) {
      if (!fence.current.current(generation)) return;
      if (e instanceof APIError && e.status === 401) invalidate();
      setError(message(e));
    }
  }, [apply, invalidate]);
  useEffect(() => {
    const generation = fence.current.generation;
    void api<{ demo: boolean }>("/mode")
      .then((v) => {
        // Deployment mode also applies to the signed-out page.
        setDemo(typeof v.demo === "boolean" ? v.demo : null);
      })
      .catch(() => {});
    void api<{ deviceId: string; demo?: boolean }>("/session")
      .then((v) => {
        if (fence.current.current(generation)) beginSession(v.deviceId, v.demo);
      })
      .catch(() => {
        if (fence.current.current(generation)) invalidate();
      });
  }, [beginSession, invalidate]);
  useEffect(() => {
    if (!session) return;
    const generation = fence.current.generation;
    void refresh();
    const events = new EventSource("/api/events");
    eventSource.current = events;
    events.onopen = () => {
      if (fence.current.current(generation)) setStream("Live");
    };
    events.addEventListener("snapshot", (event) => {
      if (!fence.current.current(generation)) return;
      try {
        apply(JSON.parse((event as MessageEvent<string>).data), generation);
        if (fence.current.current(generation)) setStream("Live");
      } catch {
        setError("An update could not be read. Reload the latest state.");
      }
    });
    events.onerror = () => {
      if (!fence.current.current(generation)) return;
      setStream("Reconnecting");
      void api<{ deviceId: string; demo?: boolean }>("/session")
        .then((value) => {
          if (
            fence.current.current(generation) &&
            value.deviceId !== fence.current.deviceId
          ) {
            invalidate();
            setError(
              "The device session changed in another page. Sign in again.",
            );
          }
        })
        .catch((e) => {
          if (
            fence.current.current(generation) &&
            e instanceof APIError &&
            e.status === 401
          )
            invalidate();
        });
    };
    return () => {
      events.close();
      if (eventSource.current === events) eventSource.current = null;
    };
  }, [session, sessionGeneration, refresh, apply, invalidate]);
  const mutate: Mutate = async (path, body, method) => {
    const generation = fence.current.generation;
    const expectedDeviceId = fence.current.deviceId;
    if (!expectedDeviceId) return null;
    setPending(true);
    setError("");
    try {
      const result = await api<Record<string, unknown>>(
        path,
        body,
        method,
        expectedDeviceId,
      );
      if (!fence.current.current(generation)) return null;
      if (result.snapshot) apply(result.snapshot as Snapshot, generation);
      else await refresh();
      return fence.current.current(generation) ? result : null;
    } catch (e) {
      if (!fence.current.current(generation)) return null;
      if (
        e instanceof APIError &&
        (e.status === 401 || e.code === "DEVICE_SESSION_CHANGED")
      )
        invalidate();
      setError(message(e));
      if (
        e instanceof APIError &&
        e.status === 409 &&
        fence.current.current(generation)
      )
        await refresh();
      return null;
    } finally {
      if (fence.current.current(generation)) setPending(false);
    }
  };
  const logout = async () => {
    const expectedDeviceId = fence.current.deviceId || undefined;
    const generation = clearSession(null);
    setSession(null);
    setError("");
    try {
      await api("/session", undefined, "DELETE", expectedDeviceId);
    } catch (e) {
      if (fence.current.current(generation)) setError(message(e));
    } finally {
      if (fence.current.current(generation)) setSession(false);
    }
  };
  const owner = snapshot?.items.find(
    (i) => i.itemKey === snapshot.displaying?.itemKey,
  );
  const selected = snapshot?.items.find((i) => i.itemKey === snapshot.selected);
  const cardItem =
    snapshot?.health.status === "healthy" && owner ? owner : selected;
  const cardStatus = !snapshot
    ? "Unknown"
    : snapshot.health.status === "blocked"
      ? "Blocked by device"
      : snapshot.health.status === "offline"
        ? "Device offline · unconfirmed"
        : owner && snapshot.health.status === "healthy"
          ? "Displaying · API confirmed"
          : snapshot.applying
            ? "Applying · awaiting confirmation"
            : selected
              ? "Selected · awaiting dispatch"
              : "Native calendar";
  return (
    <>
      {demo && (
        <div className="demo-banner">
          DEMO · Simulated device. Use test data only. No real BUSY Bar is
          controlled.
        </div>
      )}
      <header>
        <Brand />
        <span className="device-name">
          <Icon name="device" />
          {session ? "Your BUSY Bar" : "Control plane"}
        </span>
        <span
          className={"connection " + (stream === "Live" && session ? "ok" : "")}
        >
          <i />
          {session
            ? stream === "Live"
              ? "Connected"
              : "Reconnecting"
            : "Not signed in"}
        </span>
        {session && (
          <button className="text-button signout" onClick={() => void logout()}>
            Sign out
          </button>
        )}
      </header>
      {error && (
        <div className="error" role="alert">
          {error}
          <button onClick={() => setError("")} aria-label="Dismiss error">
            <Icon name="end" />
          </button>
        </div>
      )}
      {session === null ? (
        <main className="signin">
          <h1>Connecting…</h1>
        </main>
      ) : !session ? (
        <SignIn
          demo={demo === true}
          onSignIn={beginSession}
          onError={setError}
        />
      ) : !snapshot ? (
        <main className="signin">
          <h1>Loading your device…</h1>
          <button onClick={() => void refresh()}>Try again</button>
        </main>
      ) : (
        <>
          <main className="dashboard">
            <section className="queue-area" aria-labelledby="queue-title">
              <div className="section-title">
                <h1 id="queue-title">Display queue</h1>
                <span className={"live " + (stream !== "Live" ? "stale" : "")}>
                  <i />
                  {stream}
                </span>
              </div>
              {stream !== "Live" && (
                <p className="inline-warning" role="status">
                  Updates are delayed. The queue below may be stale. Cloud
                  scheduling continues independently.
                </p>
              )}
              <div
                className={
                  "owner " +
                  (owner && snapshot.health.status === "healthy"
                    ? owner.level
                    : "idle")
                }
              >
                <span className="eyeline">{cardStatus}</span>
                <h2>{cardItem?.title || "Nothing needs the display"}</h2>
                <div className="owner-bottom">
                  <div className="owner-details">
                    <Meta label="Status">
                      <span className={"badge " + (cardItem?.level || "")}>
                        {cardItem?.level || snapshot.health.status}
                      </span>
                    </Meta>
                    <Meta label="Source">
                      {cardItem
                        ? serviceName(snapshot, cardItem.serviceId)
                        : "BUSY Bar"}
                      <small>
                        {cardItem?.instanceId}
                        {cardItem && !cardItem.source.connected
                          ? " · Source offline"
                          : ""}
                      </small>
                    </Meta>
                    <Meta label="Exit">
                      {cardItem
                        ? cardItem.remainingMs === null
                          ? "Source ends"
                          : "Fixed visible time"
                        : "Calendar fallback"}
                    </Meta>
                    <Meta label="Time">
                      {cardItem
                        ? cardItem.remainingMs === null
                          ? "Until resolved"
                          : `${Math.ceil(cardItem.remainingMs / 1000)} seconds remaining`
                        : "—"}
                    </Meta>
                  </div>
                  {owner?.actionKeys.includes("primary") && (
                    <button
                      className="accent"
                      disabled={
                        pending ||
                        !owner.actionAvailable ||
                        snapshot.health.status !== "healthy"
                      }
                      onClick={() =>
                        void mutate("/actions", {
                          requestId: crypto.randomUUID(),
                          itemKey: owner.itemKey,
                          generation: snapshot.generation,
                          actionKey: "primary",
                        })
                      }
                    >
                      <Icon name="play" />
                      Run action
                    </button>
                  )}
                </div>
                {cardItem?.detail && (
                  <p className="owner-detail">{cardItem.detail}</p>
                )}
                {snapshot.actions
                  .filter((a) => a.itemKey === owner?.itemKey)
                  .slice(-1)
                  .map((a) => (
                    <p className="action-result" role="status" key={a.id}>
                      Action: {a.status}
                      {a.status === "unknown"
                        ? " · Check the source before you retry."
                        : ""}
                    </p>
                  ))}
              </div>
              <div className="queue-heading">
                <h2>All notifications</h2>
                <span>
                  {snapshot.items.length} active{" "}
                  {snapshot.items.length === 1 ? "item" : "items"}
                </span>
              </div>
              <Queue snapshot={snapshot} mutate={mutate} pending={pending} />
            </section>
            <aside className="settings" aria-label="Device and services">
              <div className="device-heading">
                <h2>Device</h2>
                <span
                  className={
                    "health " +
                    (snapshot.health.status === "healthy" ? "ok" : "")
                  }
                >
                  <i />
                  {snapshot.health.status}
                </span>
              </div>
              <dl className="device-facts">
                <dt>Identity</dt>
                <dd title={snapshot.deviceId}>
                  {snapshot.deviceId.slice(0, 14)}…
                </dd>
                <dt>Last confirmation</dt>
                <dd>{time(snapshot.health.lastSuccessAt)}</dd>
                <dt>Configuration</dt>
                <dd>Revision {snapshot.configRevision}</dd>
              </dl>
              <div className="services-heading">
                <h2>Services</h2>
                <button
                  className="accent"
                  onClick={() => setRegister((v) => !v)}
                >
                  <Icon name="plus" />
                  Register
                </button>
              </div>
              {register && (
                <Register
                  revision={snapshot.configRevision}
                  mutate={mutate}
                  pending={pending}
                  onCreated={(value) => {
                    setSecret(value);
                    setRegister(false);
                  }}
                />
              )}
              {snapshot.services.length === 0 && (
                <p className="muted">
                  Register a service to connect a local collector.
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
                    onCredential={setSecret}
                  />
                ))}
              </div>
            </aside>
          </main>
          <footer>
            <span>
              <i className={stream === "Live" ? "ok-dot" : ""} />
              {stream === "Live"
                ? "Device state synchronized"
                : "Waiting for connection"}
            </span>
            <span>
              Last synced {time(lastSync)}
              <button
                onClick={() => void refresh()}
                aria-label="Reload device state"
              >
                <Icon name="refresh" />
              </button>
            </span>
          </footer>
          {secret && (
            <Credential
              setupMode={collectorSetupMode(demo, location.hostname)}
              value={secret}
              template={
                snapshot.services.find((service) => service.id === secret.id)
                  ?.template
              }
              onClose={() => setSecret(null)}
            />
          )}
        </>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
