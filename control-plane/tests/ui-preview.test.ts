import { describe, it, expect } from "vitest";
import * as browser from "../ui/session";
import * as client from "../ui/api";
import type { Snapshot, QueueItem } from "../ui/api";

const device = "a".repeat(64),
  other = "b".repeat(64),
  now = 1800000000000;
const stream = "11111111-1111-4111-8111-111111111111";
const status = {
  deviceId: device,
  connected: true,
  streamId: stream,
  viewerId: "22222222-2222-4222-8222-222222222222",
  demand: true,
};
const frame = {
  deviceId: device,
  streamId: stream,
  sequence: 1,
  capturedAt: now - 40,
  receivedAt: now - 10,
  width: 72,
  height: 16,
  pixels: btoa("\0".repeat(3456)),
};
describe("actual preview frame isolation", () => {
  it("preserves an explicit unconfirmed-pixels label without treating it as delivery proof", () => {
    const fence = new browser.PreviewFence(device);
    fence.status(status);
    expect(
      fence.frame({ ...frame, displayConfirmed: false }, now)?.displayConfirmed,
    ).toBe(false);
    expect(
      fence.frame({ ...frame, sequence: 2, displayConfirmed: "yes" }, now),
    ).toBeNull();
    expect(
      fence.frame({ ...frame, sequence: 2, displayConfirmed: true }, now)
        ?.displayConfirmed,
    ).toBe(true);
  });
  it("paces fresh frames without a startup or post-stall catch-up burst", () => {
    expect(typeof browser.FramePacer).toBe("function");
    const pacer = new browser.FramePacer();
    expect(pacer.allow(0)).toBe(true);
    expect(pacer.allow(16)).toBe(false);
    expect(pacer.allow(34)).toBe(true);
    expect(pacer.allow(1000)).toBe(true);
    expect(pacer.allow(1016)).toBe(false);
    expect(pacer.allow(1034)).toBe(true);
  });
  it("does not catch up after a delayed animation frame", () => {
    const pacer = new browser.FramePacer();
    expect(pacer.allow(0)).toBe(true);
    expect(pacer.allow(50)).toBe(true);
    expect(pacer.allow(67)).toBe(false);
    expect(pacer.allow(84)).toBe(true);
  });
  it("keeps 30 Hz on a 60 Hz animation clock with timestamp jitter", () => {
    const pacer = new browser.FramePacer();
    let draws = 0;
    for (let i = 0; i < 600; i++)
      if (pacer.allow((i * 1000) / 60 + (i % 3) * 0.15)) draws++;
    expect(draws).toBeGreaterThanOrEqual(298);
    expect(draws).toBeLessThanOrEqual(301);
    const delayed = new browser.FramePacer();
    expect(delayed.allow(0)).toBe(true);
    expect(delayed.allow(49)).toBe(true);
    expect(delayed.allow(67)).toBe(false);
  });
  it("rechecks freshness when a pending frame is drawn", () => {
    expect(browser.frameIsFresh(frame, now)).toBe(true);
    expect(browser.frameIsFresh(frame, now + 2001)).toBe(false);
    expect(browser.frameIsFresh(frame, now - 40000)).toBe(false);
  });
  it("provides a frame fence separate from queue revision state", () => {
    expect(typeof browser.PreviewFence).toBe("function");
  });
  it("accepts only the announced stream for the verified device", () => {
    const fence = new browser.PreviewFence(device);
    expect(fence.frame(frame, now)).toBeNull();
    expect(fence.status({ ...status, deviceId: other })).toBe(false);
    expect(fence.status(status)).toBe(true);
    expect(fence.frame({ ...frame, deviceId: other }, now)).toBeNull();
    expect(fence.frame({ ...frame, streamId: "other" }, now)).toBeNull();
    expect(fence.frame(frame, now)).toEqual(frame);
  });
  it("rejects replay and stale data and clears the old stream on disconnect", () => {
    const fence = new browser.PreviewFence(device);
    fence.status(status);
    expect(fence.frame(frame, now)).not.toBeNull();
    expect(fence.frame(frame, now)).toBeNull();
    expect(
      fence.frame({ ...frame, sequence: 2, receivedAt: now - 3000 }, now),
    ).toBeNull();
    expect(fence.frame({ ...frame, sequence: 2, pixels: "x" }, now)).toBeNull();
    expect(fence.frame({ ...frame, sequence: 2, width: 160 }, now)).toBeNull();
    fence.status({ ...status, connected: false, streamId: null });
    expect(fence.frame({ ...frame, sequence: 3 }, now)).toBeNull();
    fence.status({ ...status, streamId: "new-stream" });
    expect(
      fence.frame({ ...frame, streamId: "new-stream" }, now),
    ).not.toBeNull();
  });
  it.each([-60000, -2300, 60000])(
    "uses relay age and local arrival when the browser clock differs by %i ms",
    (offset) => {
      const fence = new browser.PreviewFence(device);
      fence.status(status);
      const accepted = fence.frame({ ...frame, serverNow: now }, now + offset);
      expect(accepted?.receivedAt).toBe(now + offset - 10);
      expect(browser.frameIsFresh(accepted!, now + offset + 1990)).toBe(true);
      expect(browser.frameIsFresh(accepted!, now + offset + 1991)).toBe(false);
      expect(
        fence.frame({ ...frame, serverNow: now }, now + offset),
      ).toBeNull();
    },
  );
  it("rejects expired or invalid relay age even with browser clock skew", () => {
    const fence = new browser.PreviewFence(device);
    fence.status(status);
    for (const serverNow of [now + 2000, now - 11, NaN, "now"])
      expect(fence.frame({ ...frame, serverNow }, now + 60000)).toBeNull();
  });
  it.each([-60000, 60000])(
    "accepts an authenticated old relay during rollout with %i ms clock skew",
    (offset) => {
      const fence = new browser.PreviewFence(device);
      fence.status({
        ...status,
        lastFrameAt: frame.receivedAt,
        lastSequence: 1,
      });
      const accepted = fence.frame(frame, now + offset);
      expect(accepted?.receivedAt).toBe(now + offset);
      expect(browser.frameIsFresh(accepted!, now + offset + 2001)).toBe(false);
      expect(fence.frame(frame, now + offset)).toBeNull();
      expect(
        fence.frame(
          { ...frame, sequence: 2, receivedAt: frame.receivedAt - 1 },
          now + offset,
        ),
      ).toBeNull();
      expect(
        fence.frame(
          { ...frame, sequence: 2, receivedAt: frame.receivedAt + 500 },
          now + offset + 500,
        )?.receivedAt,
      ).toBe(now + offset + 500);
    },
  );
  it("fences old-relay cached sequence and resets floors on stream change", () => {
    const fence = new browser.PreviewFence(device);
    fence.status({ ...status, lastFrameAt: null, lastSequence: null });
    expect(fence.frame(frame, now + 60000)?.receivedAt).toBe(now + 60000);
    fence.status({ ...status, lastFrameAt: now, lastSequence: 5 });
    expect(
      fence.frame({ ...frame, sequence: 4, receivedAt: now }, now + 60000),
    ).toBeNull();
    expect(
      fence.frame({ ...frame, sequence: 5, receivedAt: now }, now + 60000),
    ).not.toBeNull();
    fence.status({
      ...status,
      streamId: "two",
      lastFrameAt: now - 100,
      lastSequence: 1,
    });
    expect(
      fence.frame(
        { ...frame, streamId: "two", receivedAt: now - 100 },
        now + 60000,
      ),
    ).not.toBeNull();
    fence.status({ ...status, connected: false, streamId: null });
    expect(
      fence.frame({ ...frame, streamId: "two", sequence: 2 }, now + 60000),
    ).toBeNull();
  });
});
describe("compact queue provenance", () => {
  const item = {
    serviceId: "mac",
    instanceId: "laptop",
    title: "GitHub title is not provenance",
    firstRecognizedAt: 5,
    receivedAt: 42,
  } as QueueItem;
  const snapshot = {
    services: [{ id: "mac", name: "Home Mac", template: "notifier" }],
    items: [item],
  } as Snapshot;
  it("uses explicit app metadata and server receipt time", () => {
    expect(typeof client.queueMetadata).toBe("function");
    expect(client.queueMetadata({ ...item, app: "codex" }, snapshot)).toEqual({
      app: "Codex",
      appId: "codex",
      sender: "laptop · Home Mac",
      receivedAt: 42,
      priorityGroup: "follow-queue",
    });
  });
  it("does not guess app or sender from the notification body", () => {
    expect(client.queueMetadata(item, snapshot)).toEqual({
      app: "Notifier",
      appId: "notifier",
      sender: "laptop · Home Mac",
      receivedAt: 42,
      priorityGroup: "follow-queue",
    });
    expect(
      client.queueMetadata({ ...item, app: "my-custom-app" }, snapshot).app,
    ).toBe("my-custom-app");
  });
  it("reports the service group independently of source urgency and app metadata", () => {
    const grouped = {
      ...snapshot,
      services: [
        { ...snapshot.services[0], priorityGroup: "dispensable" as const },
      ],
    };
    expect(
      client.queueMetadata({ ...item, level: "urgent", app: "codex" }, grouped)
        .priorityGroup,
    ).toBe("dispensable");
    expect(
      client.queueMetadata({ ...item, serviceId: "missing" }, grouped)
        .priorityGroup,
    ).toBeNull();
  });
  it("distinguishes multiple instances sharing a registered service", () => {
    const shared = {
      ...snapshot,
      items: [item, { ...item, instanceId: "desktop" }],
    } as Snapshot;
    expect(client.queueMetadata(item, shared).sender).toBe("laptop · Home Mac");
  });
});

it("shortens only the visible sender computer ID and retains the service name", async () => {
  const { compactSender } = await import("../ui/queue-metadata");
  expect(compactSender("2199977f-a93e-40b1-9c25-3ebc95fa524d · Codex")).toBe(
    "2199977f · Codex",
  );
  expect(compactSender("new-1 · Mac · Notifier")).toBe(
    "new-1 · Mac · Notifier",
  );
});
