import "../src/index";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { verifySession } from "../src/security";
import { enrollTestBrowser } from "./helpers/computer";

const created = new Set<string>();
afterEach(async () => {
  vi.restoreAllMocks();
  for (const device of created) {
    await runInDurableObject(
      env.DEVICES.getByName(device),
      async (_, state) => {
        await state.storage.deleteAlarm();
      },
    );
  }
  created.clear();
});
async function login() {
  // Synthetic device identity and token; no real upstream traffic.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ device: { serial_number: crypto.randomUUID() } }),
  );
  const response = await exports.default.fetch(
    "https://control.test/api/session",
    {
      method: "POST",
      headers: {
        Origin: "https://control.test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: "MOCK-browser-session" }),
    },
  );
  expect(response.status).toBe(200);
  const { deviceId } = (await response.json()) as { deviceId: string };
  created.add(deviceId);
  const header = response.headers.get("Set-Cookie")!;
  const cookie = header.split(";")[0];
  return { deviceId, cookie, header };
}
async function session(cookie: string, method = "GET") {
  const response = await exports.default.fetch(
    "https://control.test/api/session",
    {
      method,
      headers: { Cookie: cookie, Origin: "https://control.test" },
    },
  );
  const body = await response.json();
  return { response, body };
}
it("keeps the same paired browser session after 12 hours and expires it after 30 days", async () => {
  const start = Date.now();
  const { deviceId, cookie, header } = await login();
  expect(header).toContain("Max-Age=2592000");
  for (const flag of ["Secure", "HttpOnly", "SameSite=Strict"])
    expect(header).toContain(flag);
  const signed = decodeURIComponent(cookie.slice("busy_session=".length));
  const claims = await verifySession(signed, env.SESSION_SIGNING_KEY, start);
  expect(claims?.expiresAt).toBeGreaterThanOrEqual(start + 30 * 86400000);
  const computerId = await enrollTestBrowser(deviceId, cookie);
  vi.spyOn(Date, "now").mockReturnValue(start + 13 * 3600000);
  const active = await session(cookie);
  expect(active.response.status).toBe(200);
  expect(active.body).toMatchObject({ deviceId, computerId });
  vi.spyOn(Date, "now").mockReturnValue(start + 30 * 86400000 + 60000);
  expect((await session(cookie)).response.status).toBe(401);
});
it("sign out revokes a signed cookie immediately, before its long expiry", async () => {
  const { cookie } = await login();
  expect((await session(cookie)).response.status).toBe(200);
  const logout = await session(cookie, "DELETE");
  expect(logout.response.status).toBe(200);
  expect(logout.response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect((await session(cookie)).response.status).toBe(401);
});
