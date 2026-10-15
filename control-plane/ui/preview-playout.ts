import { frameIsFresh } from "./preview-session";
import type { PreviewFrame } from "./preview-session";

const delayMs = 150;
const maxPendingMs = 500;
const maxFrames = 6;

/** A short playout window for frames already accepted by PreviewFence. */
export class PreviewPlayout {
  private pending: { frame: PreviewFrame; arrivedAt: number }[] = [];
  private last: Pick<
    PreviewFrame,
    "deviceId" | "streamId" | "sequence" | "capturedAt"
  > | null = null;
  private lastArrival = 0;
  private offset = 0;
  private startAt = 0;

  get size() {
    return this.pending.length;
  }

  clear() {
    this.pending = [];
    this.last = null;
    this.lastArrival = 0;
    this.offset = 0;
    this.startAt = 0;
  }

  push(frame: PreviewFrame, now: number) {
    // Defense in depth: reject replay before a timestamp can trigger reanchor.
    if (
      this.last &&
      frame.deviceId === this.last.deviceId &&
      frame.streamId === this.last.streamId &&
      frame.sequence <= this.last.sequence
    )
      return;
    if (
      this.last &&
      (frame.deviceId !== this.last.deviceId ||
        frame.streamId !== this.last.streamId ||
        frame.capturedAt < this.last.capturedAt ||
        frame.capturedAt - this.last.capturedAt > maxPendingMs ||
        now < this.lastArrival ||
        now - this.lastArrival > maxPendingMs)
    )
      this.clear();
    const observedOffset = now - frame.capturedAt;
    if (!this.last) {
      this.offset = observedOffset;
      this.startAt = now + delayMs;
    } else {
      // The newest member of a coalesced batch lowers the latency floor.
      // Anchoring to its oldest member would retain the entire initial backlog.
      this.offset = Math.min(this.offset, observedOffset);
    }
    this.last = {
      deviceId: frame.deviceId,
      streamId: frame.streamId,
      sequence: frame.sequence,
      capturedAt: frame.capturedAt,
    };
    this.lastArrival = now;
    this.pending.push({ frame, arrivedAt: now });
    if (this.pending.length > maxFrames) this.pending.shift();
  }

  private dueIndex(now: number, wallNow: number) {
    this.pending = this.pending.filter(
      ({ frame, arrivedAt }) =>
        now >= arrivedAt &&
        now - arrivedAt <= maxPendingMs &&
        frameIsFresh(frame, wallNow),
    );
    if (now < this.startAt) return -1;
    let due = -1;
    for (let i = 0; i < this.pending.length; i++) {
      // Capture timestamps are rounded to milliseconds; allow the same 1 ms
      // boundary tolerance as FramePacer, without advancing the startup gate.
      if (this.pending[i].frame.capturedAt + this.offset + delayMs <= now + 1)
        due = i;
    }
    return due;
  }

  ready(now: number, wallNow: number) {
    return this.dueIndex(now, wallNow) >= 0;
  }

  take(now: number, wallNow: number): PreviewFrame | null {
    const due = this.dueIndex(now, wallNow);
    if (due < 0) return null;
    const frame = this.pending[due].frame;
    // Discard missed history, retain future work, and never repeat a draw.
    this.pending.splice(0, due + 1);
    return frame;
  }
}
