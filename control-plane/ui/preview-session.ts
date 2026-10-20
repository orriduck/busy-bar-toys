export interface PreviewFrame {
  deviceId: string;
  streamId: string;
  sequence: number;
  capturedAt: number;
  receivedAt: number;
  serverNow?: number;
  width: 72;
  height: 16;
  pixels: string;
}
export interface PreviewStatus {
  deviceId: string;
  connected: boolean;
  streamId: string | null;
  viewerId?: string;
  serviceId?: string | null;
  instanceId?: string | null;
  demand: boolean;
  acceptedFps?: number;
  lastFrameAt?: number | null;
  lastSequence?: number | null;
  viewers?: number;
}
export class FramePacer {
  private next: number | null = null;
  private last: number | null = null;
  allow(now: number) {
    const step = 1000 / 30;
    // RAF timestamps jitter around the nominal 60 Hz boundary. Retain phase,
    // with 1 ms tolerance, but never repay missed work with adjacent RAF draws.
    const tolerance = 1;
    if (
      (this.next !== null && now + tolerance < this.next) ||
      (this.last !== null && now - this.last < step - tolerance)
    )
      return false;
    this.next =
      this.next === null || now - this.next > step / 2 - tolerance
        ? now + step
        : this.next + step;
    this.last = now;
    return true;
  }
}
export function frameIsFresh(
  frame: Pick<PreviewFrame, "receivedAt">,
  now = Date.now(),
) {
  return (
    Number.isSafeInteger(frame.receivedAt) &&
    now - frame.receivedAt <= 2000 &&
    frame.receivedAt - now <= 30000
  );
}
/** A new instance is owned by one verified browser login and one SSE connection. */
export class PreviewFence {
  private stream: string | null = null;
  private sequence = 0;
  private relayFloor: number | null = null;
  private sequenceFloor = 0;
  constructor(private readonly deviceId: string) {}
  status(value: unknown): value is PreviewStatus {
    if (!value || typeof value !== "object") return false;
    const v = value as PreviewStatus;
    if (
      v.deviceId !== this.deviceId ||
      typeof v.connected !== "boolean" ||
      typeof v.demand !== "boolean" ||
      (v.streamId !== null && typeof v.streamId !== "string")
    )
      return false;
    const stream = v.connected ? v.streamId : null;
    if (stream !== this.stream) {
      this.stream = stream;
      this.sequence = 0;
      this.relayFloor = null;
      this.sequenceFloor = 0;
    }
    // Older relays already enforce a two-second cache/emission lifetime. Their
    // authenticated initial status supplies a receipt/sequence floor, allowing
    // rolling upgrades without comparing clocks on different machines.
    if (
      stream &&
      (v.lastFrameAt === null || Number.isSafeInteger(v.lastFrameAt))
    ) {
      this.relayFloor = Math.max(this.relayFloor ?? 0, v.lastFrameAt ?? 0);
      if (Number.isSafeInteger(v.lastSequence) && v.lastSequence! > 0)
        this.sequenceFloor = Math.max(this.sequenceFloor, v.lastSequence!);
    }
    return true;
  }
  frame(value: unknown, now = Date.now()): PreviewFrame | null {
    if (!value || typeof value !== "object") return null;
    const v = value as PreviewFrame;
    if (
      !this.stream ||
      v.deviceId !== this.deviceId ||
      v.streamId !== this.stream ||
      !Number.isSafeInteger(v.sequence) ||
      v.sequence <= this.sequence ||
      v.sequence < this.sequenceFloor ||
      v.width !== 72 ||
      v.height !== 16 ||
      !Number.isSafeInteger(v.receivedAt) ||
      !Number.isSafeInteger(v.capturedAt) ||
      !(v.serverNow === undefined
        ? this.relayFloor === null
          ? frameIsFresh(v, now)
          : v.receivedAt >= this.relayFloor
        : Number.isSafeInteger(v.serverNow) &&
          v.serverNow >= v.receivedAt &&
          v.serverNow - v.receivedAt <= 2000) ||
      typeof v.pixels !== "string" ||
      !/^[A-Za-z0-9+/]{4608}$/.test(v.pixels)
    )
      return null;
    this.sequence = v.sequence;
    // Keep the relay's age budget, then expire on this browser's clock.
    // Transport queues remain latest-only; playout also drops coalesced history
    // and frames waiting more than 500 ms on the browser main thread.
    return v.serverNow === undefined && this.relayFloor === null
      ? v
      : {
          ...v,
          receivedAt:
            now - (v.serverNow === undefined ? 0 : v.serverNow - v.receivedAt),
        };
  }
}
