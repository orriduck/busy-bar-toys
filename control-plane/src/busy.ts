import { ProtocolError, requireThat, record, validateElements } from "./model";
import { boundedBody } from "./security";
export const NAMESPACE = "busy-control";
export const BUSY_ORIGIN = "https://api.busy.app/busybar";
export function allowRequest(method: string, path: string) {
  requireThat(
    path.startsWith("/") &&
      !path.includes("%") &&
      !path.includes("#") &&
      !path.includes("..") &&
      !path.includes("\\"),
    "DEVICE_PATH_NOT_ALLOWED",
    403,
  );
  const url = new URL(BUSY_ORIGIN + path);
  const rawPath = path.split("?")[0];
  const entries = [...url.searchParams];
  requireThat(
    new Set(entries.map(([key]) => key)).size === entries.length,
    "DEVICE_PARAMS_NOT_ALLOWED",
    403,
  );
  if (
    method === "GET" &&
    ["/status", "/status/device", "/version"].includes(rawPath) &&
    entries.length === 0
  )
    return;
  if (method === "POST" && rawPath === "/display/draw" && entries.length === 0)
    return;
  if (
    method === "DELETE" &&
    rawPath === "/display/draw" &&
    entries.length === 1 &&
    url.searchParams.get("application_name") === NAMESPACE
  )
    return;
  if (
    method === "POST" &&
    rawPath === "/assets/upload" &&
    entries.length === 2 &&
    url.searchParams.get("application_name") === NAMESPACE &&
    /^slot-(?:[0-9]|1[0-5])\.(png|gif|webp|anim)$/.test(
      url.searchParams.get("file") ?? "",
    )
  )
    return;
  throw new ProtocolError("DEVICE_REQUEST_NOT_ALLOWED", 403);
}
/** The optional service binding is used by local DEMO config and tests only. It never changes destination. */
export class BusyClient {
  constructor(
    private token: string,
    private upstream?: Pick<Fetcher, "fetch">,
  ) {}
  async request(
    method: string,
    path: string,
    payload?: object | Uint8Array,
  ): Promise<unknown> {
    allowRequest(method, path);
    if (method === "POST" && path === "/display/draw") {
      const b = record(payload);
      requireThat(
        Object.keys(b).every((k) =>
          [
            "application_name",
            "priority",
            "led_notification_color",
            "elements",
          ].includes(k),
        ) &&
          b.application_name === NAMESPACE &&
          b.priority === 50,
        "DEVICE_DRAW_PARAMS",
        403,
      );
      if (b.led_notification_color !== undefined)
        requireThat(
          typeof b.led_notification_color === "string" &&
            /^#[0-9a-fA-F]{8}$/.test(b.led_notification_color),
          "DEVICE_DRAW_PARAMS",
          403,
        );
      requireThat(
        Array.isArray(b.elements) &&
          b.elements.length > 0 &&
          b.elements.length <= 32,
        "DEVICE_DRAW_PARAMS",
        403,
      );
      validateElements(
        b.elements.map((raw) => {
          const e = { ...record(raw) };
          requireThat(
            Number.isInteger(e.timeout) &&
              Number(e.timeout) >= 1 &&
              Number(e.timeout) <= 60 &&
              !("display_until" in e),
            "DEVICE_TIMEOUT",
            403,
          );
          delete e.timeout;
          if (e.path !== undefined) {
            requireThat(
              typeof e.path === "string" &&
                /^slot-(?:[0-9]|1[0-5])\.(png|gif|webp|anim)$/.test(e.path),
              "DEVICE_ASSET_PATH",
              403,
            );
            delete e.path;
            e.assetHash = "0".repeat(64);
          }
          return e;
        }),
      );
    } else if (method === "DELETE" && payload) {
      const b = record(payload);
      requireThat(
        Object.keys(b).every((k) =>
          ["application_name", "element_ids"].includes(k),
        ) && b.application_name === NAMESPACE,
        "DEVICE_CLEAR_PARAMS",
        403,
      );
      if (b.element_ids !== undefined)
        requireThat(
          Array.isArray(b.element_ids) &&
            b.element_ids.length <= 64 &&
            b.element_ids.every(
              (id) => typeof id === "string" && /^[\w.-]{1,64}$/.test(id),
            ),
          "DEVICE_CLEAR_PARAMS",
          403,
        );
    } else if (method === "GET")
      requireThat(payload === undefined, "DEVICE_READ_PARAMS", 403);
    else if (path.startsWith("/assets/upload"))
      requireThat(
        payload instanceof Uint8Array &&
          payload.length > 0 &&
          payload.length <= 262144,
        "DEVICE_UPLOAD_PARAMS",
        403,
      );

    requireThat(
      this.token.length > 0 && !/\s/.test(this.token),
      "INVALID_DEVICE_TOKEN",
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const isBytes = payload instanceof Uint8Array;
      const headers: Record<string, string> = {
        Authorization: "Bearer " + this.token,
        Accept: "application/json",
      };
      if (payload)
        headers["Content-Type"] = isBytes
          ? "application/octet-stream"
          : "application/json";
      const request = new Request(BUSY_ORIGIN + path, {
        method,
        headers,
        redirect: "manual",
        signal: controller.signal,
        body: payload
          ? isBytes
            ? Uint8Array.from(payload)
            : JSON.stringify(payload)
          : undefined,
      });
      const response = await (this.upstream
        ? this.upstream.fetch(request)
        : fetch(request));
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProtocolError(
          response.status === 409
            ? "DEVICE_BLOCKED"
            : response.status === 401 || response.status === 403
              ? "DEVICE_AUTH_REJECTED"
              : "UPSTREAM_FAILURE",
          response.status === 409 ? 409 : 502,
        );
      }
      const bytes = await boundedBody(response, 65536);
      try {
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new ProtocolError("UPSTREAM_INVALID_RESPONSE", 502);
      }
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("UPSTREAM_UNAVAILABLE", 502);
    } finally {
      clearTimeout(timer);
    }
  }
}
