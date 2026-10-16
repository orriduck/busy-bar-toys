import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "./components/ui/tooltip";
import {
  skipToken,
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  cacheSnapshot,
  clearSnapshotCache,
  snapshotKey,
} from "./snapshot-cache";
import { Button } from "./components/ui/button";
import { Alert, AlertAction, AlertDescription } from "./components/ui/alert";
import { Skeleton } from "./components/ui/skeleton";
import { api, APIError, message } from "./api";
import type { Snapshot, Mutate } from "./api";
import { Brand, Icon } from "./common";
import { cn } from "./lib/utils";
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
import { MotionPage } from "./motion";
import "./style.css";
function App() {
  const [session, setSession] = useState<boolean | null>(null);
  const queryClient = useQueryClient();
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
  const { data: snapshot } = useQuery<Snapshot>({
    queryKey: snapshotKey(fence.current.deviceId, sessionGeneration),
    queryFn: skipToken,
    staleTime: Infinity,
    gcTime: 0,
    // Only fenced SSE/refresh acceptance may populate this subscription.
  });
  const request = useMutation({
    mutationFn: ({
      path,
      body,
      method,
      deviceId,
    }: {
      path: string;
      body?: unknown;
      method?: string;
      deviceId?: string;
    }) => api<Record<string, unknown>>(path, body, method, deviceId),
    retry: false,
    gcTime: 0,
  });
  const eventStream = useRef<ReturnType<typeof startEventStream> | null>(null);
  const clearSession = useCallback(
    (deviceId: string | null) => {
      const generation = fence.current.reset(deviceId);
      setSessionGeneration(generation);
      eventStream.current?.close();
      eventStream.current = null;
      clearSnapshotCache(queryClient);
      request.reset();
      setSecret(null);
      setPage("display");
      setPreviewStats(null);
      setPending(false);
      setLastSync(undefined);
      setStream("Connecting");
      return generation;
    },
    [queryClient, request.reset],
  );
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
      if (!cacheSnapshot(queryClient, fence.current, value, generation))
        return false;
      setLastSync(Date.now());
      return true;
    },
    [invalidate, queryClient],
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
      const result = await request.mutateAsync({
        path,
        body,
        method,
        deviceId: expectedDeviceId,
      });
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
      request.reset();
      if (fence.current.current(generation)) setPending(false);
    }
  };
  const logout = async () => {
    const expectedDeviceId = fence.current.deviceId || undefined;
    const generation = clearSession(null);
    setSession(null);
    setError("");
    try {
      await request.mutateAsync({
        path: "/session",
        method: "DELETE",
        deviceId: expectedDeviceId,
      });
    } catch (e) {
      if (fence.current.current(generation)) setError(message(e));
    } finally {
      request.reset();
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
      <div
        className="app-shell"
        data-demo={demo || undefined}
        data-docked={Boolean(session && snapshot && page !== "display")}
      >
        <header className="app-header">
          <Brand />
        </header>
        <aside className="sidebar">
          {session && <Navigation page={page} onPage={setPage} />}
        </aside>
        <main className="workspace" id="main-content" data-page={page}>
          {error && (
            <Alert variant="destructive" className="error">
              <AlertDescription>{error}</AlertDescription>
              <AlertAction>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setError("")}
                  aria-label="Dismiss error"
                >
                  <Icon name="end" />
                </Button>
              </AlertAction>
            </Alert>
          )}
          {session === null ? (
            <MotionPage key="connecting" className="auth-slot" active>
              <section className="signin">
                <h1>Connecting…</h1>
                <Skeleton className="h-12 w-64" />
              </section>
            </MotionPage>
          ) : !session ? (
            <MotionPage key="signin" className="auth-slot" active>
              <SignIn
                demo={demo === true}
                onSignIn={beginSession}
                onError={setError}
              />
            </MotionPage>
          ) : !snapshot ? (
            <MotionPage key="loading" className="auth-slot" active>
              <section className="signin">
                <h1>Loading your device…</h1>
                <Skeleton className="h-12 w-64" />
                <Button variant="secondary" onClick={() => void refresh()}>
                  Try again
                </Button>
              </section>
            </MotionPage>
          ) : (
            <>
              {/* Keep this host and its keyed Preview in place across navigation. */}
              <section
                className={cn(
                  "preview-host",
                  page === "display"
                    ? "preview-host-full"
                    : "preview-host-dock",
                )}
                aria-label="Live device preview"
              >
                <div className="preview-caption">
                  <strong>BUSY Bar</strong>
                  <span>Front display</span>
                </div>
                <Preview
                  key={`${snapshot.deviceId}-${sessionGeneration}`}
                  deviceId={snapshot.deviceId}
                  active
                  onSessionEnd={invalidate}
                  onStats={setPreviewStats}
                />
              </section>
              <MotionPage active={page === "display"}>
                <section className="display-page" aria-label="Display">
                  <Queue
                    snapshot={snapshot}
                    mutate={mutate}
                    pending={pending}
                  />
                  {stream !== "Live" && (
                    <Alert className="queue-warning" role="status">
                      <AlertDescription>
                        Queue updates are delayed.
                      </AlertDescription>
                    </Alert>
                  )}
                </section>
              </MotionPage>
              <MotionPage active={page === "services"}>
                <ServicesPage
                  snapshot={snapshot}
                  mutate={mutate}
                  pending={pending}
                  onCredential={setSecret}
                />
              </MotionPage>
              <MotionPage active={page === "configuration"}>
                <ConfigurationPage
                  snapshot={snapshot}
                  mutate={mutate}
                  pending={pending}
                  onCredential={setSecret}
                />
              </MotionPage>
              <MotionPage active={page === "device"}>
                <DevicePage
                  snapshot={snapshot}
                  active={page === "device"}
                  stream={stream}
                  lastSync={lastSync}
                  stats={previewStats}
                  onRefresh={() => void refresh()}
                  onLogout={() => void logout()}
                />
              </MotionPage>
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
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false, gcTime: 0 },
  },
});
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </QueryClientProvider>,
);
