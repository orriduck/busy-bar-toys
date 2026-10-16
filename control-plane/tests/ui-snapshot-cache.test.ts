import { describe, expect, it } from "vitest";
import { QueryClient, QueryObserver, skipToken } from "@tanstack/react-query";
import { createState, snapshot } from "../src/model";
import { SessionFence } from "../ui/session";
import {
  cacheSnapshot,
  clearSnapshotCache,
  snapshotKey,
} from "../ui/snapshot-cache";

const state = (deviceId: string, revision: number) => ({
  ...snapshot(createState(deviceId), 1_800_000_000_000),
  revision,
});

describe("authoritative snapshot query cache", () => {
  it("keeps a newer SSE revision when an older HTTP refresh completes", () => {
    const client = new QueryClient();
    const fence = new SessionFence();
    const generation = fence.reset("device-a");
    expect(
      cacheSnapshot(client, fence, state("device-a", 20), generation),
    ).toBe(true);
    expect(
      cacheSnapshot(client, fence, state("device-a", 19), generation),
    ).toBe(false);
    expect(client.getQueryData(snapshotKey("device-a", generation))).toEqual(
      state("device-a", 20),
    );
    client.clear();
  });

  it("notifies a disabled query subscription when an accepted SSE update arrives", async () => {
    const client = new QueryClient();
    const fence = new SessionFence();
    const generation = fence.reset("device-a");
    const observer = new QueryObserver(client, {
      queryKey: snapshotKey("device-a", generation),
      queryFn: skipToken,
    });
    const seen: unknown[] = [];
    const unsubscribe = observer.subscribe((result) => seen.push(result.data));
    const update = state("device-a", 4);
    cacheSnapshot(client, fence, update, generation);
    expect(seen).toContainEqual(update);
    unsubscribe();
    client.clear();
  });

  it("clears old device data and prevents delayed responses from repopulating it", () => {
    const client = new QueryClient();
    const fence = new SessionFence();
    const first = fence.reset("device-a");
    cacheSnapshot(client, fence, state("device-a", 99), first);
    fence.reset(null);
    clearSnapshotCache(client);
    const second = fence.reset("device-b");
    expect(cacheSnapshot(client, fence, state("device-a", 1000), first)).toBe(
      false,
    );
    expect(cacheSnapshot(client, fence, state("device-a", 1000), second)).toBe(
      false,
    );
    expect(cacheSnapshot(client, fence, state("device-b", 1), second)).toBe(
      true,
    );
    expect(client.getQueryData(snapshotKey("device-a", first))).toBeUndefined();
    expect(client.getQueryCache().getAll()).toHaveLength(1);
    client.clear();
  });

  it("isolates a second login to the same device from old high revisions", () => {
    const client = new QueryClient();
    const fence = new SessionFence();
    const first = fence.reset("device-a");
    cacheSnapshot(client, fence, state("device-a", 99), first);
    const second = fence.reset("device-a");
    clearSnapshotCache(client);
    expect(cacheSnapshot(client, fence, state("device-a", 100), first)).toBe(
      false,
    );
    expect(cacheSnapshot(client, fence, state("device-a", 1), second)).toBe(
      true,
    );
    expect(client.getQueryData(snapshotKey("device-a", first))).toBeUndefined();
    expect(client.getQueryData(snapshotKey("device-a", second))).toEqual(
      state("device-a", 1),
    );
    client.clear();
  });
});
