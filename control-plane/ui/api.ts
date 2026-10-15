import type { snapshot } from "../src/model";
export { queueMetadata } from "./queue-metadata";
export type Snapshot = ReturnType<typeof snapshot>;
export type QueueItem = Snapshot["items"][number];
export type Service = Snapshot["services"][number];
export class APIError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(
      code === "DEVICE_SESSION_CHANGED"
        ? "The device session changed in another page. Sign in again."
        : code === "DEVICE_AUTH_REJECTED"
          ? "The device token was rejected. Check its device scope and expiry."
          : status === 409
            ? "This view changed. Your changes were not saved. Review the latest state and try again."
            : status === 401
              ? "Your session expired. Sign in again."
              : status === 413
                ? "The device queue or asset cache is full. End unused items and try again."
                : status === 403
                  ? "This action is not allowed for this session."
                  : status === 502 || status === 503
                    ? "The device service is unavailable. Try again when it is connected."
                    : "The request could not be completed. Check the values and try again.",
    );
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  expectedDeviceId?: string,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(expectedDeviceId ? { "X-Busy-Device": expectedDeviceId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed: unknown = await response.json().catch(() => ({}));
  const data: Record<string, unknown> =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  if (!response.ok)
    throw new APIError(
      response.status,
      typeof data.error === "string" ? data.error : "REQUEST_FAILED",
    );
  return data as T;
}
export const time = (value: number | null | undefined) =>
  value
    ? new Date(value).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
export function etaText(item: QueueItem) {
  if (item.state === "displaying") return "Now";
  if (item.state === "applying") return "Applying";
  switch (item.eta.kind) {
    case "await-resolution":
      return "Until resolved · 待解除";
    case "estimate":
      return `Est. ${time(item.eta.at)}`;
    case "paused":
      return "Paused";
    case "snoozed":
      return `Returns ${time(item.eta.at)}`;
    default:
      return "Not yet known";
  }
}

export type Mutate = (
  path: string,
  body?: unknown,
  method?: string,
) => Promise<Record<string, unknown> | null>;
export type CredentialValue = {
  credential: string;
  epoch: string;
  epochExpiresAt: number;
  id: string;
};
export const message = (error: unknown) =>
  error instanceof Error ? error.message : "The request failed.";
