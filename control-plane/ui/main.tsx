import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, APIError, message } from "./api";
import type { Snapshot, Mutate } from "./api";
import { Brand, Icon } from "./common";
import { SignIn, Credential } from "./auth";
import { Queue } from "./queue";
import {
  Navigation,
  ServicesPage,
  ConfigurationPage,
  DevicePage,
} from "./pages";
import type { Page } from "./pages";
import { Preview } from "./preview";
import type { PreviewStats } from "./preview";
import { SessionFence, collectorSetupMode } from "./session";
import { startEventStream } from "./event-stream";
import "./style.css";
function App() {
  const [session, setSession] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [demo, setDemo] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [stream, setStream] = useState("Connecting");
  const [lastSync, setLastSync] = useState<number>();
  const [pending, setPending] = useState(false);
  const [page, setPage] = useState<Page>("display");
  const [previewStats, setPreviewStats] = useState<PreviewStats | null>(null);
  const [secret, setSecret] = useState<{
    credential: string;
    epoch: string;
    epochExpiresAt: number;
    id: string;
  } | null>(null);
  const fence = useRef(new SessionFence());
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const eventStream = useRef<ReturnType<typeof startEventStream> | null>(null);
  const clearSession = useCallback((deviceId: string | null) => {
    const generation = fence.current.reset(deviceId);
    setSessionGeneration(generation);
    eventStream.current?.close();
    eventStream.current = null;
    setSnapshot(null);
    setSecret(null);
    setPage("display");
    setPreviewStats(null);
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
    const stream = startEventStream({
      createSource: () => new EventSource("/api/events"),
      isCurrent: () => fence.current.current(generation),
      onOpen: () => setStream("Live"),
      onSnapshot: (data) => {
        try {
          const accepted = apply(JSON.parse(data), generation);
          if (accepted) setStream("Live");
          return accepted;
        } catch {
          setError("An update could not be read. Reload the latest state.");
          return false;
        }
      },
      onError: () => {
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
      },
    });
    eventStream.current = stream;
    return () => {
      stream.close();
      if (eventStream.current === stream) eventStream.current = null;
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
  return (
    <>
      {demo && (
        <div className="demo-banner">
          DEMO · Simulated device. Use test data only.
        </div>
      )}
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <div className="app-shell">
        <aside className="sidebar">
          <Brand />
          {session && <Navigation page={page} onPage={setPage} />}
        </aside>
        <main className="workspace" id="main-content">
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => setError("")} aria-label="Dismiss error">
                <Icon name="end" />
              </button>
            </div>
          )}
          {session === null ? (
            <section className="signin">
              <h1>Connecting…</h1>
            </section>
          ) : !session ? (
            <SignIn
              demo={demo === true}
              onSignIn={beginSession}
              onError={setError}
            />
          ) : !snapshot ? (
            <section className="signin">
              <h1>Loading your device…</h1>
              <button onClick={() => void refresh()}>Try again</button>
            </section>
          ) : (
            <>
              <div className="page-slot" hidden={page !== "display"}>
                <section className="display-page" aria-label="Display">
                  <Preview
                    key={`${snapshot.deviceId}-${sessionGeneration}`}
                    deviceId={snapshot.deviceId}
                    active={page === "display"}
                    onSessionEnd={invalidate}
                    onStats={setPreviewStats}
                  />
                  <Queue
                    snapshot={snapshot}
                    mutate={mutate}
                    pending={pending}
                  />
                  {stream !== "Live" && (
                    <p className="queue-warning" role="status">
                      Queue updates are delayed.
                    </p>
                  )}
                </section>
              </div>
              <div className="page-slot" hidden={page !== "services"}>
                <ServicesPage
                  snapshot={snapshot}
                  mutate={mutate}
                  pending={pending}
                  onCredential={setSecret}
                />
              </div>
              <div className="page-slot" hidden={page !== "configuration"}>
                <ConfigurationPage
                  snapshot={snapshot}
                  mutate={mutate}
                  pending={pending}
                  onCredential={setSecret}
                />
              </div>
              <div className="page-slot" hidden={page !== "device"}>
                <DevicePage
                  snapshot={snapshot}
                  active={page === "device"}
                  stream={stream}
                  lastSync={lastSync}
                  stats={previewStats}
                  onRefresh={() => void refresh()}
                  onLogout={() => void logout()}
                />
              </div>
            </>
          )}
        </main>
      </div>
      {secret && snapshot && (
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
  );
}
createRoot(document.getElementById("root")!).render(<App />);
