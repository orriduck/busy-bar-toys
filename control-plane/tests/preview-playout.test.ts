import { describe, expect, it } from "vitest";
import { PreviewPlayout } from "../ui/preview-playout";
import { FramePacer, PreviewFence } from "../ui/preview-session";
import type { PreviewFrame } from "../ui/preview-session";

const epoch = 1_800_000_000_000;
function frame(
  sequence: number,
  capture: number,
  arrival: number,
  streamId = "one",
): PreviewFrame {
  return {
    deviceId: "device",
    streamId,
    sequence,
    capturedAt: epoch + Math.round(capture),
    receivedAt: epoch + Math.round(arrival),
    width: 72,
    height: 16,
    pixels: btoa("\0".repeat(3456)),
  };
}

describe("bounded actual-frame playout", () => {
  it("smooths six-frame network batches into approximately 30 actual draws per second", () => {
    const playout = new PreviewPlayout();
    const pacer = new FramePacer();
    const fence = new PreviewFence("device");
    fence.status({
      deviceId: "device",
      connected: true,
      demand: true,
      streamId: "one",
    });
    const draws: { sequence: number; at: number; age: number }[] = [];
    let received = 0,
      latestOnly: PreviewFrame | null = null,
      latestOnlyDraws = 0;
    const latestPacer = new FramePacer();
    for (let tick = 0; tick <= 300; tick++) {
      const t = (tick * 1000) / 60;
      if (tick > 0 && tick % 12 === 0 && t <= 4800) {
        for (let i = 0; i < 6; i++) {
          const value = frame(++received, t - 200 + (i * 1000) / 30, t);
          const verified = fence.frame(value, epoch + t)!;
          expect(verified).not.toBeNull();
          playout.push(verified, t);
          latestOnly = verified;
          expect(playout.size).toBeLessThanOrEqual(6);
        }
      }
      if (latestOnly && latestPacer.allow(t)) {
        latestOnlyDraws++;
        latestOnly = null;
      }
      if (playout.ready(t, epoch + t) && pacer.allow(t)) {
        const value = playout.take(t, epoch + t)!;
        expect(value).not.toBeNull();
        draws.push({
          sequence: value.sequence,
          at: t,
          age: t - (value.capturedAt - epoch),
        });
      }
    }
    expect(received).toBe(144);
    expect(latestOnlyDraws).toBe(24);
    const steady = draws.filter((draw) => draw.at >= 1000 && draw.at < 4800);
    expect(steady.length / 3.8).toBeGreaterThanOrEqual(29);
    expect(steady.length / 3.8).toBeLessThanOrEqual(30.5);
    expect(new Set(draws.map((draw) => draw.sequence)).size).toBe(draws.length);
    expect(draws[0].at).toBeGreaterThanOrEqual(350);
    expect(Math.max(...steady.map((draw) => draw.age))).toBeLessThan(260);
    expect(playout.take(6000, epoch + 6000)).toBeNull();
  });

  it("caps startup history, waits 150 ms, and takes only the latest due frame", () => {
    const playout = new PreviewPlayout();
    for (let i = 0; i < 20; i++) playout.push(frame(i + 1, i * 33, 1000), 1000);
    expect(playout.size).toBe(6);
    expect(playout.take(1149, epoch + 1149)).toBeNull();
    expect(playout.take(1150, epoch + 1150)?.sequence).toBe(20);
    expect(playout.size).toBe(0);
    expect(playout.take(1200, epoch + 1200)).toBeNull();
  });

  it("expires pending work after 500 ms and rechecks server freshness at draw", () => {
    const playout = new PreviewPlayout();
    playout.push(frame(1, 0, 0), 0);
    expect(playout.take(501, epoch + 501)).toBeNull();
    expect(playout.size).toBe(0);
    playout.push(frame(2, 600, 600), 600);
    expect(playout.take(750, epoch + 2601)).toBeNull();
    expect(playout.size).toBe(0);
  });

  it("does not let a future frame hide due work", () => {
    const playout = new PreviewPlayout();
    playout.push(frame(1, 0, 0), 0);
    playout.push(frame(2, 100, 100), 100);
    expect(playout.take(150, epoch + 150)?.sequence).toBe(1);
    expect(playout.take(200, epoch + 200)).toBeNull();
    expect(playout.take(250, epoch + 250)?.sequence).toBe(2);
  });

  it("does not replay a duplicate with an older capture timestamp", () => {
    const playout = new PreviewPlayout();
    playout.push(frame(2, 100, 100), 100);
    expect(playout.take(250, epoch + 250)?.sequence).toBe(2);
    playout.push(frame(2, 0, 300), 300);
    expect(playout.take(450, epoch + 450)).toBeNull();
  });

  it("reanchors backwards/forwards source clock jumps and long interruptions", () => {
    for (const capture of [-10_000, 10_000, 1000]) {
      const playout = new PreviewPlayout();
      playout.push(frame(1, 0, 0), 0);
      const arrival = capture === 1000 ? 1000 : 100;
      playout.push(frame(2, capture, arrival), arrival);
      expect(playout.size).toBe(1);
      expect(playout.take(arrival + 149, epoch + arrival + 149)).toBeNull();
      expect(playout.take(arrival + 150, epoch + arrival + 150)?.sequence).toBe(
        2,
      );
      expect(playout.take(arrival + 200, epoch + arrival + 200)).toBeNull();
    }
  });

  it("clears on stream/device boundaries and explicit lifecycle resets", () => {
    const playout = new PreviewPlayout();
    playout.push(frame(1, 0, 0), 0);
    playout.push(frame(1, 100, 100, "two"), 100);
    expect(playout.take(150, epoch + 150)).toBeNull();
    expect(playout.take(250, epoch + 250)?.streamId).toBe("two");
    playout.push(frame(2, 300, 300, "two"), 300);
    playout.clear();
    expect(playout.size).toBe(0);
    expect(playout.take(500, epoch + 500)).toBeNull();
    playout.push({ ...frame(1, 600, 600), deviceId: "other" }, 600);
    expect(playout.take(749, epoch + 749)).toBeNull();
    expect(playout.take(750, epoch + 750)?.deviceId).toBe("other");
  });
});
