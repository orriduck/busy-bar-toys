import { ProtocolError, requireThat, identifier, State } from "./model";

export type PreviewAuth =
  | { kind: "session"; id: string; expiresAt: number }
  | { kind: "computer"; computerId: string; serviceId: string; hash: string }
  | { kind: "publisher"; serviceId: string; hash: string };
type Authority = Pick<State, "deviceId" | "sessions"> & {
  computers: Record<string, { credentialHash: string; revokedAt?: number }>;
  services: Record<
    string,
    {
      credentialHash: string;
      epoch: string;
      epochExpiresAt: number;
      enabled: boolean;
      allowPreview: boolean;
      computerId?: string;
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
  auth: Exclude<PreviewAuth, { kind: "session" }>;
  demandViewers: number;
  epoch: string;
  instanceId: string;
  streamId: string;
  sequence: number;
  timer: ReturnType<typeof setTimeout>;
  tokens: number;
  tokenAt: number;
  clockTimer?: ReturnType<typeof setTimeout>;
  frameTimer?: ReturnType<typeof setTimeout>;
  pendingFrame: PreviewFrame | null;
  lastActivity: number;
  activityPending: boolean;
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
  keepalivePending: boolean;
  keepaliveTimer: ReturnType<typeof setInterval>;
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
  private observedAt = 0;

  private now() {
    // Standard WebSocket callbacks can retain an older runtime clock context.
    // Only trusted server I/O observations advance this monotonic floor.
    this.observedAt = Math.max(this.observedAt, Date.now());
    return this.observedAt;
  }
  private syncClock(p: Publisher) {
    if (p.clockTimer !== undefined) return;
    p.clockTimer = setTimeout(() => {
      p.clockTimer = undefined;
      if (this.publisher !== p) return;
      this.now();
      this.revalidate();
    }, 1);
  }

  update(s: State) {
    this.authority = {
      deviceId: s.deviceId,
      sessions: { ...s.sessions },
      computers: Object.fromEntries(
        Object.values(s.computers).map((c) => [
          c.id,
          { credentialHash: c.credentialHash, revokedAt: c.revokedAt },
        ]),
      ),
      services: Object.fromEntries(
        Object.values(s.services).map((v) => [
          v.id,
          {
            credentialHash: v.credentialHash,
            epoch: v.epoch,
            epochExpiresAt: v.epochExpiresAt,
            enabled: v.config.enabled,
            allowPreview: v.config.allowPreview === true,
            computerId: v.computerId,
          },
        ]),
      ),
    };
    this.revalidate();
  }
  private authorize(auth: PreviewAuth) {
    const s = this.authority,
      now = this.now();
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
        svc &&
          Object.hasOwn(s.services, auth.serviceId) &&
          svc.epochExpiresAt > now,
        "UNAUTHORIZED",
        401,
      );
      if (auth.kind === "computer") {
        const computer = Object.hasOwn(s.computers, auth.computerId)
          ? s.computers[auth.computerId]
          : undefined;
        requireThat(
          computer &&
            computer.revokedAt === undefined &&
            svc.computerId === auth.computerId &&
            equal(computer.credentialHash, auth.hash),
          "UNAUTHORIZED",
          401,
        );
      } else
        requireThat(equal(svc.credentialHash, auth.hash), "UNAUTHORIZED", 401);
      requireThat(
        svc.enabled && svc.allowPreview,
        "PREVIEW_CAPABILITY_REQUIRED",
        403,
      );
    }
  }
  private publisherValid(p: Publisher) {
    this.authorize(p.auth);
    requireThat(
      this.authority!.services[p.auth.serviceId].epoch === p.epoch,
      "EPOCH_EXPIRED",
      409,
    );
    const now = this.now();
    // Consume validated receipt once the server clock advances, whether the
    // next I/O boundary is clock synchronization, idle expiry, or another request.
    // Authority is checked first, so revoked activity cannot renew the lease.
    if (p.activityPending && now > p.lastActivity) {
      p.lastActivity = now;
      p.activityPending = false;
    }
    requireThat(p.lastActivity + 15000 > now, "PREVIEW_PUBLISHER_IDLE");
  }
  private revalidate() {
    for (const [id, v] of this.viewers) {
      try {
        this.authorize(v.auth);
        requireThat(
          v.leaseExpiresAt > this.now() && v.deadline > this.now(),
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
    const now = this.now();
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
    requireThat(auth.kind !== "session", "FORBIDDEN", 403);
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
      pendingFrame: null,
      tokens: 6,
      tokenAt: this.now(),
      lastActivity: this.now(),
      activityPending: false,
      ingressTokens: 60,
      ingressAt: this.now(),
      timer: setTimeout(
        () => this.expirePublisher(),
        Math.max(
          1,
          Math.min(
            15000,
            this.authority!.services[auth.serviceId].epochExpiresAt -
              this.now(),
          ),
        ),
      ),
    };
    this.publisher = p;
    this.clearFrame();
    socket.addEventListener("message", (event) => {
      if (this.publisher !== p) return;
      this.syncClock(p);
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
        ) - this.now(),
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
    const now = this.now();
    p.ingressTokens = Math.min(
      60,
      p.ingressTokens + (Math.max(0, now - p.ingressAt) * 60) / 1000,
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
      p.activityPending = true;
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
    p.activityPending = true;
    requireThat(this.viewers.size > 0, "PREVIEW_NO_DEMAND");
    // The input budget permits one second of network coalescing. Forwarding
    // remains thirty/s with six-frame jitter and exactly one pending latest frame.
    p.pendingFrame = {
      deviceId: this.authority!.deviceId,
      streamId: p.streamId,
      sequence: p.sequence,
      capturedAt: Number(f.capturedAt),
      receivedAt: now,
      pixels: f.pixels as string,
      width: 72,
      height: 16,
    };
    this.forward(p);
  }
  private forward(p: Publisher) {
    if (this.publisher !== p) return;
    this.revalidate();
    if (this.publisher !== p || !this.viewers.size || !p.pendingFrame) return;
    const now = this.now();
    p.tokens = Math.min(
      6,
      p.tokens + (Math.max(0, now - p.tokenAt) * 30) / 1000,
    );
    p.tokenAt = now;
    if (p.tokens < 1) {
      if (p.frameTimer === undefined)
        p.frameTimer = setTimeout(
          () => {
            p.frameTimer = undefined;
            if (this.publisher !== p) return;
            this.now();
            this.forward(p);
          },
          Math.max(1, Math.ceil(((1 - p.tokens) * 1000) / 30)),
        );
      return;
    }
    if (p.frameTimer !== undefined) {
      clearTimeout(p.frameTimer);
      p.frameTimer = undefined;
    }
    p.tokens--;
    this.latest = p.pendingFrame;
    p.pendingFrame = null;
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
    const expiry = Math.min(auth.expiresAt, this.authority!.sessions[auth.id]);
    const abort = () => this.removeViewer(id, true);
    const v: Viewer = {
      auth,
      writer,
      writing: false,
      deadline: expiry,
      leaseExpiresAt: this.now() + 6000,
      removeAbort: () => signal?.removeEventListener("abort", abort),
      statusPending: true,
      framePending: this.freshFrame(),
      keepalivePending: false,
      keepaliveTimer: setInterval(() => {
        this.revalidate();
        if (this.viewers.get(id) !== v) return;
        v.keepalivePending = true;
        this.flush(id, v);
      }, 2000),
      timer: setTimeout(
        () => this.removeViewer(id, true),
        Math.min(6000, expiry - this.now()),
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
      v.leaseExpiresAt = this.now() + 6000;
      v.timer = setTimeout(
        () => this.removeViewer(id, true),
        Math.min(6000, v.deadline - this.now()),
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
        if (this.freshFrame())
          payload = this.event("frame", {
            ...this.latest,
            // Both timestamps belong to the relay clock. Browsers must not
            // compare receivedAt directly with a different machine's clock.
            serverNow: this.now(),
          });
      }
      if (!payload && v.keepalivePending) {
        v.keepalivePending = false;
        payload = encoder.encode(": preview keepalive\n\n");
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
    clearInterval(v.keepaliveTimer);
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
    return this.latest !== null && this.now() - this.latest.receivedAt <= 2000;
  }
  private clearFrame() {
    this.latest = null;
    if (this.publisher) {
      this.publisher.pendingFrame = null;
      if (this.publisher.frameTimer !== undefined) {
        clearTimeout(this.publisher.frameTimer);
        this.publisher.frameTimer = undefined;
      }
    }
    this.arrivals = [];
    for (const v of this.viewers.values()) v.framePending = false;
  }
  private disconnect(code: string) {
    const p = this.publisher;
    if (!p) return;
    this.publisher = null;
    clearTimeout(p.timer);
    if (p.clockTimer !== undefined) clearTimeout(p.clockTimer);
    if (p.frameTimer !== undefined) clearTimeout(p.frameTimer);
    p.pendingFrame = null;
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
