import { describe, expect, it } from "vitest";
import legacy, { type LegacyEnv } from "../src/legacy";
const old = "https://busy-bar-control-plane.orriduck.workers.dev";
function binding(fetch: (request: Request) => Promise<Response>): LegacyEnv {
  return { BTC: { fetch } as unknown as Fetcher };
}
describe("old collector endpoint", () => {
  it("redirects pages to the fixed BTC origin, retaining path/query", async () => {
    const response = await legacy.fetch(
      new Request(old + "/device?release=abc"),
      binding(async () => {
        throw Error("not API");
      }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(
      "https://btc.orriduck.workers.dev/device?release=abc",
    );
    const relative = await legacy.fetch(
      new Request(old + "//foreign.test/path"),
      binding(async () => {
        throw Error("not API");
      }),
    );
    expect(new URL(relative.headers.get("Location")!).origin).toBe(
      "https://btc.orriduck.workers.dev",
    );
  });
  it("passes publisher body/auth/origin unchanged and keeps streamed responses", async () => {
    const request = new Request(old + "/api/heartbeat", {
      method: "POST",
      headers: { Authorization: "Bearer test", Origin: old },
      body: '{"instanceId":"test"}',
    });
    const result = new Response("event: state\ndata: {}\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
    const response = await legacy.fetch(
      request,
      binding(async (forwarded) => {
        expect(forwarded).toBe(request);
        expect(forwarded.headers.get("Authorization")).toBe("Bearer test");
        expect(forwarded.headers.get("Origin")).toBe(old);
        expect(await forwarded.text()).toBe('{"instanceId":"test"}');
        return result;
      }),
    );
    expect(response).toBe(result);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  });
  it("preserves an upgrade request and lets the backend reject authentication", async () => {
    const request = new Request(old + "/api/preview/publisher", {
      headers: { Upgrade: "websocket" },
    });
    const response = await legacy.fetch(
      request,
      binding(async (forwarded) => {
        expect(forwarded.headers.get("Upgrade")).toBe("websocket");
        return new Response("unauthorized", { status: 401 });
      }),
    );
    expect(response.status).toBe(401);
  });
});
