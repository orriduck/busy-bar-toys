import type { QueryClient } from "@tanstack/react-query";
import type { Snapshot } from "./api";
import type { SessionFence } from "./session";

/** Every login gets a separate cache, even when it uses the same device. */
export const snapshotKey = (deviceId: string | null, generation: number) =>
  ["device-snapshot", deviceId, generation] as const;

/** SSE and HTTP responses share one revision gate before touching the cache. */
export function cacheSnapshot(
  client: QueryClient,
  fence: SessionFence,
  value: Snapshot,
  generation: number,
) {
  if (!fence.accept(value.deviceId, value.revision, generation)) return false;
  client.setQueryData(snapshotKey(value.deviceId, generation), value);
  return true;
}

export function clearSnapshotCache(client: QueryClient) {
  // Snapshot readers use SSE/explicit refresh; cancel also guards future fetches.
  void client.cancelQueries({ queryKey: ["device-snapshot"] });
  client.removeQueries({ queryKey: ["device-snapshot"] });
}
