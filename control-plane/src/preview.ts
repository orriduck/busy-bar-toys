import { ProtocolError, requireThat, identifier, State } from "./model";

export type PreviewAuth =
  | { kind: "session"; id: string; expiresAt: number }
  | { kind: "publisher"; serviceId: string; hash: string };
type Authority = Pick<State, "deviceId" | "sessions"> & {
  services: Record<
    string,
    {
      credentialHash: string;
      epoch: string;
      epochExpiresAt: number;
      enabled: boolean;
      allowPreview: boolean;
    }
  >;
};
type PreviewFrame = {
  deviceId: string;
  streamId: string;
  sequence: number;
  capturedAt: number;
  receivedAt: number;
  pixels: string;
  width: 72;
  height: 16;
};
type Publisher = {
  socket: WebSocket;
  auth: Extract<PreviewAuth, { kind: "publisher" }>;
  demandViewers: number;
  epoch: string;
  instanceId: string;
  streamId: string;
  sequence: number;
  timer: ReturnType<typeof setTimeout>;
  tokens: number;
  tokenAt: number;
  droppedAt: number[];
  lastActivity: number;
  ingressTokens: number;
  ingressAt: number;
};
type Viewer = {
  auth: Extract<PreviewAuth, { kind: "session" }>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  writing: boolean;
  deadline: number;
  leaseExpiresAt: number;
  removeAbort: () => void;
  timer: ReturnType<typeof setTimeout>;
  statusPending: boolean;
  framePending: boolean;
};
const encoder = new TextEncoder();
const equal = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
/** Ephemeral, read-only relay. Authority is refreshed only by durable saves/requests;
 * frames never load StateStore, schedule native commands, or persist pixel data. */
export class PreviewRelay {
  private authority: Authority | null = null;
  private publisher: Publisher | null = null;
  private viewers = new Map<string, Viewer>();
  private latest: PreviewFrame | null = null;
  private arrivals: number[] = [];

  update(s: State) {
    this.authority = {
      deviceId: s.deviceId,
      sessions: { ...s.sessions },
      services: Object.fromEntries(
        Object.values(s.services).map((v) => [
          v.id,
          {
            credentialHash: v.credentialHash,
            epoch: v.epoch,
            epochExpiresAt: v.epochExpiresAt,
            enabled: v.config.enabled,
            allowPreview: v.config.allowPreview === true,
          },
        ]),
      ),
    };
    this.revalidate();
  }
  private authorize(auth: PreviewAuth) {
    const s = this.authority,
      now = Date.now();
    requireThat(s, "UNAUTHORIZED", 401);
    if (auth.kind === "session") {
      requireThat(
        auth.expiresAt > now && s.sessions[auth.id] > now,
        "UNAUTHORIZED",
        401,
      );
    } else {
      const svc = s.services[auth.serviceId];
      requireThat(
        svc && svc.epochExpiresAt > now && equal(svc.credentialHash, auth.hash),
        "UNAUTHORIZED",
        401,
      );
      requireThat(
        svc.enabled && svc.allowPreview,
        "PREVIEW_CAPABILITY_REQUIRED",
        403,
      );
    }
  }
  private publisherValid(p: Publisher) {
    this.authorize(p.auth);
    requireThat(p.lastActivity + 15000 > Date.now(), "PREVIEW_PUBLISHER_IDLE");
    requireThat(
      this.authority!.services[p.auth.serviceId].epoch === p.epoch,
      "EPOCH_EXPIRED",
      409,
    );
  }
  private revalidate() {
    for (const [id, v] of this.viewers) {
      try {
        this.authorize(v.auth);
        requireThat(
          v.leaseExpiresAt > Date.now() && v.deadline > Date.now(),
          "PREVIEW_VIEWER_EXPIRED",
        );
      } catch {
        this.removeViewer(id, true, false);
      }
    }
    if (this.publisher) {
      try {
        this.publisherValid(this.publisher);
      } catch (error) {
        this.disconnect(
          error instanceof ProtocolError &&
            error.code === "PREVIEW_PUBLISHER_IDLE"
            ? error.code
            : "PREVIEW_AUTH_REVOKED",
        );
      }
    }
    if (!this.viewers.size) this.clearFrame();
    this.demand();
  }
  status() {
    this.revalidate();
    return this.currentStatus();
  }
  private currentStatus() {
    const now = Date.now();
    this.arrivals = this.arrivals.filter((t) => now - t < 1000);
    const p = this.publisher;
    return {
      deviceId: this.authority!.deviceId,
      connected: !!p,
      serviceId: p?.auth.serviceId ?? null,
      instanceId: p?.instanceId ?? null,
      streamId: p?.streamId ?? null,
      demand: this.viewers.size > 0,
      targetFps: 30,
      acceptedFps: this.arrivals.length,
      lastFrameAt: this.latest?.receivedAt ?? null,
      lastSequence: this.latest?.sequence ?? null,
      viewers: this.viewers.size,
    };
  }
  openPublisher(auth: PreviewAuth, instance: unknown, epoch: string | null) {
    requireThat(auth.kind === "publisher", "FORBIDDEN", 403);
    this.authorize(auth);
    const instanceId = identifier(instance);
    requireThat(
      epoch === this.authority!.services[auth.serviceId].epoch,
      "EPOCH_EXPIRED",
      409,
    );
    this.revalidate();
    requireThat(!this.publisher, "PREVIEW_PUBLISHER_EXISTS", 409);
    const pair = new WebSocketPair(),
      client = pair[0],
      socket = pair[1];
    socket.accept();
    const p: Publisher = {
      socket,
      auth,
      instanceId,
      epoch,
      demandViewers: -1,
      streamId: crypto.randomUUID(),
      sequence: 0,
      droppedAt: [],
      tokens: 6,
      tokenAt: Date.now(),
      lastActivity: Date.now(),
      ingressTokens: 16,
      ingressAt: Date.now(),
      timer: setTimeout(
        () => this.expirePublisher(),
        Math.max(
          1,
          Math.min(
            15000,
            this.authority!.services[auth.serviceId].epochExpiresAt -
              Date.now(),
          ),
        ),
      ),
    };
    this.publisher = p;
    this.clearFrame();
    socket.addEventListener("message", (event) => {
      if (this.publisher !== p) return;
      try {
        this.receive(p, event.data);
      } catch (error) {
        const code =
          error instanceof ProtocolError ? error.code : "INVALID_PREVIEW_FRAME";
        try {
          socket.send(JSON.stringify({ type: "error", code }));
        } catch {}
        if (code !== "PREVIEW_NO_DEMAND") this.disconnect(code);
      }
    });
    const disconnected = () => {
      if (this.publisher === p) this.disconnect("PREVIEW_DISCONNECTED");
    };
    socket.addEventListener("close", disconnected);
    socket.addEventListener("error", disconnected);
    this.demand();
    this.broadcastStatus();
    return new Response(null, { status: 101, webSocket: client });
  }
  private expirePublisher() {
    const p = this.publisher;
    if (!p) return;
    try {
      this.publisherValid(p);
    } catch (error) {
      this.disconnect(
        error instanceof ProtocolError &&
          error.code === "PREVIEW_PUBLISHER_IDLE"
          ? error.code
          : "PREVIEW_AUTH_REVOKED",
      );
      return;
    }
    p.timer = setTimeout(
      () => this.expirePublisher(),
      Math.max(
        1,
        Math.min(
          p.lastActivity + 15000,
          this.authority!.services[p.auth.serviceId].epochExpiresAt,
        ) - Date.now(),
      ),
    );
  }
  private receive(p: Publisher, data: string | ArrayBuffer) {
    this.revalidate();
    this.publisherValid(p);
    requireThat(this.publisher === p, "UNAUTHORIZED", 401);
    requireThat(typeof data === "string", "INVALID_PREVIEW_FRAME");
    requireThat(
      data.length <= 6144 && encoder.encode(data).length <= 6144,
      "PREVIEW_FRAME_SIZE",
      413,
    );
    const now = Date.now();
    p.ingressTokens = Math.min(
      16,
      p.ingressTokens + ((now - p.ingressAt) * 60) / 1000,
    );
    p.ingressAt = now;
    requireThat(p.ingressTokens >= 1, "PREVIEW_RATE_LIMIT", 429);
    p.ingressTokens--;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      throw new ProtocolError("INVALID_PREVIEW_FRAME");
    }
    const f = raw as Record<string, unknown>;
    if (
      f &&
      typeof f === "object" &&
      !Array.isArray(f) &&
      f.type === "heartbeat" &&
      Object.keys(f).length === 1
    ) {
      p.lastActivity = now;
      return;
    }
    requireThat(
      f &&
        typeof f === "object" &&
        !Array.isArray(f) &&
        Object.keys(f).every((k) =>
          ["type", "sequence", "capturedAt", "pixels"].includes(k),
        ) &&
        f.type === "frame" &&
        Number.isSafeInteger(f.sequence) &&
        Number(f.sequence) > 0 &&
        Number.isSafeInteger(f.capturedAt) &&
        typeof f.pixels === "string" &&
        /^[A-Za-z0-9+/]{4608}$/.test(f.pixels),
      "INVALID_PREVIEW_FRAME",
    );
    requireThat(
      Math.abs(now - Number(f.capturedAt)) <= 30000,
      "PREVIEW_STALE_FRAME",
    );
    requireThat(Number(f.sequence) > p.sequence, "PREVIEW_SEQUENCE", 409);
    p.sequence = Number(f.sequence);
    p.lastActivity = now;
    requireThat(this.viewers.size > 0, "PREVIEW_NO_DEMAND");
    // Thirty sustained arrivals/s with six-frame jitter allowance; no unbounded queue.
    p.tokens = Math.min(6, p.tokens + ((now - p.tokenAt) * 30) / 1000);
    p.tokenAt = now;
    if (p.tokens < 1) {
      p.droppedAt = p.droppedAt.filter((t) => now - t < 1000);
      p.droppedAt.push(now);
      requireThat(p.droppedAt.length <= 30, "PREVIEW_RATE_LIMIT", 429);
      return;
    }
    p.tokens--;
    this.latest = {
      deviceId: this.authority!.deviceId,
      streamId: p.streamId,
      sequence: p.sequence,
      capturedAt: Number(f.capturedAt),
      receivedAt: now,
      pixels: f.pixels as string,
      width: 72,
      height: 16,
    };
    this.arrivals.push(now);
    this.arrivals = this.arrivals.filter((t) => now - t < 1000);
    for (const [id, v] of this.viewers) {
      v.framePending = true;
      this.flush(id, v);
    }
  }
  openViewer(auth: PreviewAuth, expected: string, signal?: AbortSignal) {
    requireThat(auth.kind === "session", "FORBIDDEN", 403);
    this.authorize(auth);
    requireThat(
      expected === this.authority!.deviceId,
      "DEVICE_SESSION_CHANGED",
      409,
    );
    this.revalidate();
    requireThat(this.viewers.size < 8, "PREVIEW_VIEWER_CAPACITY", 429);
    const id = crypto.randomUUID();
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const expiry = Math.min(
      auth.expiresAt,
      this.authority!.sessions[auth.id],
      Date.now() + 55000,
    );
    const abort = () => this.removeViewer(id, true);
    const v: Viewer = {
      auth,
      writer,
      writing: false,
      deadline: expiry,
      leaseExpiresAt: Date.now() + 6000,
      removeAbort: () => signal?.removeEventListener("abort", abort),
      statusPending: true,
      framePending: this.freshFrame(),
      timer: setTimeout(
        () => this.removeViewer(id, true),
        Math.min(6000, expiry - Date.now()),
      ),
    };
    this.viewers.set(id, v);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    void writer.closed.catch(() => this.removeViewer(id, false));
    this.demand();
    this.broadcastStatus();
    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        Connection: "keep-alive",
      },
    });
  }
  viewer(auth: PreviewAuth, id: string, operation: unknown) {
    requireThat(auth.kind === "session", "FORBIDDEN", 403);
    this.authorize(auth);
    this.revalidate();
    requireThat(
      operation === "renew" || operation === "close",
      "INVALID_REQUEST",
    );
    const v = this.viewers.get(id);
    requireThat(v, "PREVIEW_VIEWER_NOT_FOUND", 404);
    requireThat(v.auth.id === auth.id, "FORBIDDEN", 403);
    if (operation === "close") this.removeViewer(id, true);
    else {
      clearTimeout(v.timer);
      v.leaseExpiresAt = Date.now() + 6000;
      v.timer = setTimeout(
        () => this.removeViewer(id, true),
        Math.min(6000, v.deadline - Date.now()),
      );
    }
    return { ok: true };
  }
  private event(name: string, value: unknown) {
    return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  private flush(id: string, v: Viewer) {
    try {
      this.authorize(v.auth);
      if (v.writing) return;
      let payload: Uint8Array | undefined;
      if (v.statusPending) {
        v.statusPending = false;
        payload = this.event("preview", {
          ...this.currentStatus(),
          viewerId: id,
        });
      } else if (v.framePending) {
        v.framePending = false;
        if (this.freshFrame()) payload = this.event("frame", this.latest);
      }
      if (!payload) return;
      v.writing = true;
      void v.writer.write(payload).then(
        () => {
          v.writing = false;
          if (this.viewers.get(id) === v) this.flush(id, v);
        },
        () => this.removeViewer(id, false),
      );
    } catch {
      this.removeViewer(id, true);
    }
  }
  private removeViewer(id: string, close: boolean, notify = true) {
    const v = this.viewers.get(id);
    if (!v) return;
    this.viewers.delete(id);
    clearTimeout(v.timer);
    v.removeAbort();
    if (close) {
      // Abort a backpressured write so an event awaiting consumption cannot
      // escape after expiry. With no pending write, a graceful close is sufficient.
      const closed = v.writing
        ? v.writer.abort(new Error("PREVIEW_VIEWER_CLOSED"))
        : v.writer.close();
      void closed.catch(() => {});
    }
    if (!this.viewers.size) this.clearFrame();
    if (notify) {
      this.demand();
      this.broadcastStatus();
    }
  }
  private demand() {
    const p = this.publisher;
    if (!p) return;
    const enabled = this.viewers.size > 0;
    if (p.demandViewers === this.viewers.size) return;
    p.demandViewers = this.viewers.size;
    try {
      p.socket.send(
        JSON.stringify({
          type: "demand",
          enabled,
          targetFps: 30,
          streamId: p.streamId,
          deviceId: this.authority!.deviceId,
        }),
      );
    } catch {
      this.disconnect("PREVIEW_DISCONNECTED");
    }
  }
  private broadcastStatus() {
    for (const [id, v] of this.viewers) {
      v.statusPending = true;
      this.flush(id, v);
    }
  }
  private freshFrame() {
    return this.latest !== null && Date.now() - this.latest.receivedAt <= 2000;
  }
  private clearFrame() {
    this.latest = null;
    this.arrivals = [];
    for (const v of this.viewers.values()) v.framePending = false;
  }
  private disconnect(code: string) {
    const p = this.publisher;
    if (!p) return;
    this.publisher = null;
    clearTimeout(p.timer);
    this.clearFrame();
    // A backpressured writer owns an already encoded event, independently of
    // latest/framePending. Abort that transport before invalidation returns so
    // it cannot deliver a frame from the disconnected publisher afterwards.
    for (const [id, viewer] of this.viewers)
      if (viewer.writing) this.removeViewer(id, true, false);
    try {
      p.socket.close(1008, code);
    } catch {}
    this.broadcastStatus();
  }
}
