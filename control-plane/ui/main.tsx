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
import { startEventStream, startPageEventStream } from "./event-stream";
import { MotionPage } from "./motion";
import "./style.css";
import "./theme.css";
import "./mobile.css";
import { ThemeToggle, useTheme } from "./theme-control";
import { OfflineNotice, registerAppWorker } from "./pwa";
function App() {
  const appearance = useTheme();
  const [ownerComputerId, setOwnerComputerId] = useState<string | null>(null);
  const [session, setSession] = useState<boolean | null>(null);
  const queryClient = useQueryClient();
  const [demo, setDemo] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [sessionCheckError, setSessionCheckError] = useState("");
  const checkingSession = useRef<number | null>(null);
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
      setOwnerComputerId(null);
      setSecret(null);
      setPage("display");
      setPreviewStats(null);
      setPending(false);
      setLastSync(undefined);
      setStream("Connecting");
      setSessionCheckError("");
      return generation;
    },
    [queryClient, request.reset],
  );
  const beginSession = useCallback(
    (
      deviceId: string,
      serverDemo: boolean | undefined,
      computerId: string | null = null,
    ) => {
      if (!/^[a-f0-9]{64}$/.test(deviceId)) {
        clearSession(null);
        setSession(false);
        setError("The device identity could not be verified.");
        return;
      }
      clearSession(deviceId);
      setOwnerComputerId(computerId);
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
  const checkSession = useCallback(async () => {
    const generation = fence.current.generation;
    if (checkingSession.current === generation) return;
    checkingSession.current = generation;
    setSessionCheckError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const value = await api<{
        deviceId: string;
        demo?: boolean;
        computerId?: string | null;
      }>("/session", undefined, "GET", undefined, controller.signal);
      if (!/^[a-f0-9]{64}$/.test(value.deviceId))
        throw new Error("Invalid session response");
      if (fence.current.current(generation))
        beginSession(value.deviceId, value.demo, value.computerId ?? null);
    } catch (error) {
      if (!fence.current.current(generation)) return;
      if (error instanceof APIError && error.status === 401) invalidate();
      else
        setSessionCheckError(
          "Your saved sign-in has not been cleared. Check your connection and try again.",
        );
    } finally {
      window.clearTimeout(timeout);
      if (checkingSession.current === generation)
        checkingSession.current = null;
    }
  }, [beginSession, invalidate]);
  useEffect(() => {
    void api<{ demo: boolean }>("/mode")
      .then((v) => {
        // Deployment mode also applies to the signed-out page.
        setDemo(typeof v.demo === "boolean" ? v.demo : null);
      })
      .catch(() => {});
    void checkSession();
  }, [checkSession]);
  useEffect(() => {
    if (session !== null || !sessionCheckError) return;
    const retry = () => void checkSession();
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    window.addEventListener("pageshow", retry);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retry);
      window.removeEventListener("pageshow", retry);
    };
  }, [session, sessionCheckError, checkSession]);
  useEffect(() => {
    if (!session) return;
    const generation = fence.current.generation;
    void refresh();
    const stream = startPageEventStream({
      onPause: () => setStream("Paused"),
      onResume: () => setStream("Connecting"),
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
        void api<{
          deviceId: string;
          demo?: boolean;
          computerId?: string | null;
        }>("/session")
          .then((value) => {
            if (
              fence.current.current(generation) &&
              value.deviceId === fence.current.deviceId
            )
              setOwnerComputerId(value.computerId ?? null);
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
  useEffect(() => {
    if (!session) return;
    const check = () => {
      const generation = fence.current.generation;
      void api<{ deviceId: string; computerId: string | null }>("/session")
        .then((value) => {
          if (!fence.current.current(generation)) return;
          if (value.deviceId !== fence.current.deviceId) {
            invalidate();
            return;
          }
          setOwnerComputerId(value.computerId ?? null);
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
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [session, sessionGeneration, invalidate]);
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
        data-navigation={Boolean(session)}
        data-docked={Boolean(session && snapshot && page !== "display")}
      >
        <header className="app-header">
          <Brand />
          <ThemeToggle
            mode={appearance.mode}
            onCycle={appearance.cycle}
            className="theme-toggle-desktop"
          />
        </header>
        <aside className="sidebar">
          {session && (
            <Navigation page={page} onPage={setPage} appearance={appearance} />
          )}
        </aside>
        <main className="workspace" id="main-content" data-page={page}>
          <OfflineNotice />
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
                <h1>
                  {sessionCheckError ? "Connection interrupted" : "Connecting…"}
                </h1>
                {sessionCheckError ? (
                  <>
                    <p role="status">{sessionCheckError}</p>
                    <Button
                      variant="secondary"
                      onClick={() => void checkSession()}
                    >
                      Try again
                    </Button>
                  </>
                ) : (
                  <Skeleton className="h-12 w-64" />
                )}
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
                    ownerComputerId={ownerComputerId}
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
                  ownerComputerId={ownerComputerId}
                  onPaired={setOwnerComputerId}
                  snapshot={snapshot}
                  mutate={mutate}
                  pending={pending}
                  onCredential={setSecret}
                />
              </MotionPage>
              <MotionPage active={page === "configuration"}>
                <ConfigurationPage
                  ownerComputerId={ownerComputerId}
                  onPaired={setOwnerComputerId}
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
registerAppWorker();
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
