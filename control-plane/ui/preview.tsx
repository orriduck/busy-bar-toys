import { useEffect, useRef, useState } from "react";
import { api, APIError } from "./api";
import { PreviewFence, FramePacer, frameIsFresh } from "./preview-session";
import { PreviewPlayout } from "./preview-playout";
import { startEventStream } from "./event-stream";
import type { PreviewFrame, PreviewStatus } from "./preview-session";
export interface PreviewStats {
  deviceId: string;
  received: number;
  drawn: number;
  receivedFps: number;
  drawnFps: number;
  latencyMs: number | null;
  sampledAt: number;
}
export function Preview({
  deviceId,
  active,
  onSessionEnd,
  onStats,
}: {
  deviceId: string;
  active: boolean;
  onSessionEnd: () => void;
  onStats: (stats: PreviewStats) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(
    !document.hidden && document.hasFocus?.() !== false,
  );
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState("Waiting for preview");
  useEffect(() => {
    let inView = true;
    let focused = document.hasFocus?.() !== false;
    const change = () => setVisible(!document.hidden && focused && inView);
    const focus = () => {
      focused = true;
      change();
      // A blur closes the lease immediately. Reconnect even if a very quick
      // blur/focus pair was batched without an intermediate React render.
      setAttempt((n) => n + 1);
    };
    const blur = () => {
      focused = false;
      change();
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setAttempt((n) => n + 1);
    };
    document.addEventListener("visibilitychange", change);
    window.addEventListener("pageshow", restore);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            inView = entry?.isIntersecting === true;
            change();
          })
        : null;
    if (canvas.current) observer?.observe(canvas.current);
    return () => {
      document.removeEventListener("visibilitychange", change);
      window.removeEventListener("pageshow", restore);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      observer?.disconnect();
    };
  }, []);
  useEffect(() => {
    const surface = canvas.current,
      ctx = surface?.getContext("2d");
    if (!surface || !ctx) return;
    ctx.clearRect(0, 0, surface.width, surface.height);
    if (!active || !visible) return;
    let live = true,
      fence = new PreviewFence(deviceId),
      viewerId: string | null = null;
    let shownFrame: PreviewFrame | null = null,
      announcedStream: string | null = null,
      shown = false;
    let delayed = false,
      lastFrameArrival = performance.now();
    const pacer = new FramePacer();
    const playout = new PreviewPlayout();
    surface.dataset.receivedFrames = "0";
    surface.dataset.drawnFrames = "0";
    let received = 0,
      drawn = 0,
      previousReceived = 0,
      previousDrawn = 0,
      sampled = performance.now(),
      latency: number | null = null;
    let raf = 0,
      restarting: ReturnType<typeof setTimeout> | undefined;
    setMessage("Waiting for preview");
    let currentEvents: EventSource | null = null;
    const closeLease = () => {
      const id = viewerId;
      viewerId = null;
      if (id)
        void fetch("/api/preview/viewer", {
          method: "POST",
          credentials: "same-origin",
          keepalive: true,
          headers: {
            "Content-Type": "application/json",
            "X-Busy-Device": deviceId,
          },
          body: JSON.stringify({ viewerId: id, operation: "close" }),
        }).catch(() => {});
    };
    const clearSurface = (text: string) => {
      shown = false;
      delayed = false;
      shownFrame = null;
      latency = null;
      ctx.clearRect(0, 0, surface.width, surface.height);
      if (live) setMessage(text);
    };
    const blank = (text: string) => {
      playout.clear();
      clearSurface(text);
    };
    const verifySession = async () => {
      try {
        const value = await api<PreviewStatus>(
          "/preview/status",
          undefined,
          "GET",
          deviceId,
        );
        if (live && value.deviceId !== deviceId) onSessionEnd();
      } catch (error) {
        if (
          live &&
          error instanceof APIError &&
          (error.status === 401 || error.code === "DEVICE_SESSION_CHANGED")
        )
          onSessionEnd();
      }
    };
    const receiveStatus = (data: string) => {
      if (!live) return false;
      try {
        const value: unknown = JSON.parse(data);
        if (!fence.status(value)) {
          blank("Device session changed");
          onSessionEnd();
          return false;
        }
        const stream = value.connected ? value.streamId : null;
        if (stream !== announcedStream) {
          announcedStream = stream;
          blank(stream ? "Waiting for preview" : "Preview bridge unavailable");
        }
        if (
          typeof value.viewerId === "string" &&
          /^[A-Za-z0-9_-]{1,64}$/.test(value.viewerId)
        )
          viewerId = value.viewerId;
        if (!value.connected) blank("Preview bridge unavailable");
        return true;
      } catch {
        blank("Preview could not be read");
        return false;
      }
    };
    const receiveFrame = (event: Event) => {
      if (!live) return;
      try {
        const frame = fence.frame(
          JSON.parse((event as MessageEvent<string>).data),
        );
        if (!frame) return;
        lastFrameArrival = performance.now();
        playout.push(frame, performance.now());
        received++;
        surface.dataset.receivedFrames = String(received);
        surface.dataset.sequence = String(frame.sequence);
        surface.dataset.streamId = frame.streamId;
      } catch {
        blank("Preview could not be read");
      }
    };
    const connection = startEventStream({
      eventName: "preview",
      isCurrent: () => live,
      createSource: () => {
        const events = new EventSource(`/api/preview/frames/${deviceId}`);
        currentEvents = events;
        events.addEventListener("frame", (event) => {
          if (currentEvents === events) receiveFrame(event);
        });
        return events;
      },
      onOpen: () => {},
      onSnapshot: receiveStatus,
      onError: () => {
        closeLease();
        fence = new PreviewFence(deviceId);
        blank("Reconnecting preview…");
        void verifySession();
      },
    });
    const restart = () => {
      closeLease();
      currentEvents = null;
      connection.close();
      if (!restarting)
        restarting = setTimeout(() => {
          if (live) setAttempt((n) => n + 1);
        }, 1000);
    };
    const renewal = setInterval(() => {
      // An OPEN EventSource can stop delivering frames without an error.
      // Recover one existing lease, with no extra device reads or polling.
      if (live && performance.now() - lastFrameArrival > 15000) {
        restart();
        return;
      }
      const id = viewerId;
      if (!id || !live) return;
      void api(
        "/preview/viewer",
        { viewerId: id, operation: "renew" },
        "POST",
        deviceId,
      ).catch((error) => {
        if (!live || viewerId !== id) return;
        if (
          error instanceof APIError &&
          (error.status === 401 || error.code === "DEVICE_SESSION_CHANGED")
        ) {
          blank("Sign in to resume preview");
          onSessionEnd();
        } else if (error instanceof APIError && error.status === 404) {
          blank("Reconnecting preview…");
          restart();
        }
      });
    }, 2000);
    const paint = (t: number) => {
      if (!live) return;
      const now = Date.now();
      // RAF's timestamp precedes callback execution. Use the same monotonic
      // clock as enqueue, so a newly arrived frame is never considered future.
      const playoutNow = performance.now();
      const ready = playout.ready(playoutNow, now);
      if (shownFrame && !frameIsFresh(shownFrame, now)) {
        // Retain the last verified pixels with an explicit age. A short pause
        // while native writes take priority must not turn the preview black.
        delayed = true;
        latency = null;
        setMessage(
          `Last preview · ${Math.max(2, Math.floor((now - shownFrame.receivedAt) / 1000))}s ago`,
        );
      }
      const frame =
        ready && pacer.allow(t) ? playout.take(playoutNow, now) : null;
      if (
        frame &&
        frame.deviceId === deviceId &&
        frame.streamId === announcedStream &&
        frameIsFresh(frame, Date.now())
      ) {
        shownFrame = frame;
        const raw = atob(frame.pixels);
        ctx.clearRect(0, 0, 720, 160);
        for (let y = 0; y < 16; y++)
          for (let x = 0; x < 72; x++) {
            const i = (y * 72 + x) * 3,
              r = raw.charCodeAt(i),
              g = raw.charCodeAt(i + 1),
              b = raw.charCodeAt(i + 2);
            if (!r && !g && !b) continue;
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.beginPath();
            ctx.arc(x * 10 + 5, y * 10 + 5, 4.1, 0, Math.PI * 2);
            ctx.fill();
          }
        drawn++;
        latency = Math.max(0, Date.now() - frame.capturedAt);
        surface.dataset.drawnFrames = String(drawn);
        surface.dataset.drawnSequence = String(frame.sequence);
        if (!shown || delayed) {
          shown = true;
          delayed = false;
          setMessage("");
        }
      }
      if (t - sampled >= 1000) {
        const seconds = (t - sampled) / 1000;
        onStats({
          deviceId,
          received,
          drawn,
          receivedFps: (received - previousReceived) / seconds,
          drawnFps: (drawn - previousDrawn) / seconds,
          latencyMs: latency,
          sampledAt: Date.now(),
        });
        sampled = t;
        previousReceived = received;
        previousDrawn = drawn;
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    const leave = () => {
      blank("Preview paused");
      live = false;
      cancelAnimationFrame(raf);
      closeLease();
      connection.close();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("blur", leave);
    return () => {
      live = false;
      closeLease();
      connection.close();
      clearInterval(renewal);
      clearTimeout(restarting);
      cancelAnimationFrame(raf);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("blur", leave);
      playout.clear();
      ctx.clearRect(0, 0, surface.width, surface.height);
    };
  }, [deviceId, active, visible, attempt, onSessionEnd, onStats]);
  return (
    <div className="bar-preview" aria-label="Actual BUSY Bar front display">
      <img
        className="bar-shell"
        src="/busy-device-shell.webp"
        alt=""
        width="1024"
        height="330"
      />
      <canvas
        ref={canvas}
        width="720"
        height="160"
        aria-label="Live device pixels"
        data-device-id={deviceId}
      />
      {message && (
        <div
          className={`preview-message${message.startsWith("Last preview") ? " preview-stale" : ""}`}
          role="status"
        >
          {message}
        </div>
      )}
    </div>
  );
}
