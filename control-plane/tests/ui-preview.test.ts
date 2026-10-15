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
      sender: "Home Mac",
      receivedAt: 42,
    });
  });
  it("does not guess app or sender from the notification body", () => {
    expect(client.queueMetadata(item, snapshot)).toEqual({
      app: "Notifier",
      appId: "notifier",
      sender: "Home Mac",
      receivedAt: 42,
    });
    expect(
      client.queueMetadata({ ...item, app: "my-custom-app" }, snapshot).app,
    ).toBe("my-custom-app");
  });
  it("distinguishes multiple instances sharing a registered service", () => {
    const shared = {
      ...snapshot,
      items: [item, { ...item, instanceId: "desktop" }],
    } as Snapshot;
    expect(client.queueMetadata(item, shared).sender).toBe("Home Mac / laptop");
  });
});
