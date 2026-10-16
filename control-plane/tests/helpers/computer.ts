import { exports } from "cloudflare:workers";
import { expect } from "vitest";

/** Test publishers use the same enrollment flow as a real local installation. */
export async function enrollTestBrowser(deviceId: string, cookie: string) {
  const origin = "https://control.test";
  const ticket = await exports.default.fetch(
    origin + "/api/computers/enrollment",
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "X-Busy-Device": deviceId,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  expect(ticket.status).toBe(201);
  const value = (await ticket.json()) as {
    enrollment: string;
    computerId: string;
  };
  const response = await exports.default.fetch(
    origin + "/api/computers/enroll",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + value.enrollment,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        managementSecret: "test-computer-key-" + "x".repeat(32),
      }),
    },
  );
  expect(response.status).toBe(201);
  // Consume the RPC-backed body so the enrollment call does not pin the DO.
  expect(await response.json()).toMatchObject({
    computerId: value.computerId,
    enrolled: true,
  });
  return value.computerId;
}
