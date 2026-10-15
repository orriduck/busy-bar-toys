import { it, expect } from "vitest";
import { BusyClient, allowRequest } from "../src/busy";
import {
  encrypt,
  decrypt,
  digest,
  signSession,
  verifySession,
} from "../src/security";
import { cacheAsset, reserveSlots } from "../src/assets";
import { createState } from "../src/model";
it("rejects arbitrary paths, methods, encodings, parameters and namespace escapes", () => {
  for (const [method, path] of [
    ["GET", "/wifi/status"],
    ["POST", "/status"],
    ["GET", "/%73tatus"],
    ["DELETE", "/display/draw"],
    ["DELETE", "/display/draw?application_name=other"],
    ["POST", "/assets/upload?application_name=busy-control&file=../x"],
    ["GET", "/status?x=1"],
    ["GET", "https://evil.test/status"],
  ])
    expect(() => allowRequest(method, path)).toThrow();
  expect(() =>
    allowRequest("DELETE", "/display/draw?application_name=busy-control"),
  ).not.toThrow();
});
it("encrypts device token using per-value random IV and authenticated encryption", async () => {
  const key = "00".repeat(32);
  const a = await encrypt("secret", key),
    b = await encrypt("secret", key);
  expect(a).not.toBe(b);
  expect(a).not.toContain("secret");
  expect(await decrypt(a, key)).toBe("secret");
  await expect(decrypt(a, "01".repeat(32))).rejects.toThrow();
});
it("session signatures reject expiry, tampering, and wrong key", async () => {
  const signed = await signSession(
    { deviceId: "a".repeat(64), id: "id", expiresAt: 100 },
    "key",
  );
  expect((await verifySession(signed, "key", 50))?.id).toBe("id");
  expect(await verifySession(signed, "key", 101)).toBeNull();
  expect(await verifySession(signed + "x", "key", 50)).toBeNull();
  expect(await verifySession(signed, "other", 50)).toBeNull();
});
it("BUSY fetch uses fixed origin, rejects redirects and bounds response size", async () => {
  let target = "",
    redirect = "";
  const client = new BusyClient("fake", {
    fetch: async (request: Request) => {
      target = request.url;
      redirect = request.redirect;
      return new Response("redirect", { status: 302 });
    },
  } as Pick<Fetcher, "fetch">);
  await expect(client.request("GET", "/status")).rejects.toThrow("UPSTREAM");
  expect(target).toBe("https://api.busy.app/busybar/status");
  expect(redirect).toBe("manual");
});
it("cloud cache validates content hashes and asset slots cannot overwrite pins", async () => {
  const s = createState("device"),
    data = btoa("fakeimage"),
    hash = await digest("fakeimage");
  await expect(
    cacheAsset(s, "a", { hash: "0".repeat(64), type: "png", data }, 1),
  ).rejects.toThrow("HASH");
  await cacheAsset(s, "a", { hash, type: "png", data }, 1);
  const [slot] = reserveSlots(s, [hash], new Set(), 1);
  expect(slot.slot).toBe(0);
  expect(reserveSlots(s, [hash], new Set([0]), 2)[0].slot).toBe(0);
  for (let j = 1; j < 16; j++) {
    const h = String(j).padStart(64, "0");
    s.assets[h] = {
      hash: h,
      type: "png",
      data,
      bytes: 1,
      owners: ["a"],
      usedAt: 1,
    };
    reserveSlots(s, [h], new Set(s.slots.map((i) => i.slot)), 2);
  }
  const h = "f".repeat(64);
  s.assets[h] = {
    hash: h,
    type: "png",
    data,
    bytes: 1,
    owners: ["a"],
    usedAt: 1,
  };
  expect(() =>
    reserveSlots(s, [h], new Set(s.slots.map((i) => i.slot)), 2),
  ).toThrow("SLOT_CAPACITY");
});
it("dedicated BUSY client enforces backend namespace and draw parameters", async () => {
  const client = new BusyClient("fake", {
    fetch: async () => Response.json({ ok: true }),
  } as Pick<Fetcher, "fetch">);
  await expect(
    client.request("POST", "/display/draw", {
      application_name: "other",
      priority: 100,
      elements: [{ id: "a", type: "text" }],
    }),
  ).rejects.toThrow("DEVICE");
  await expect(
    client.request("DELETE", "/display/draw?application_name=busy-control", {
      application_name: "other",
    }),
  ).rejects.toThrow("DEVICE");
});
it("global slots never create extra filenames through extension changes", () => {
  const s = createState("device");
  for (let n = 0; n < 16; n++) {
    const hash = String(n).padStart(64, "0");
    s.assets[hash] = {
      hash,
      type: "png",
      data: "AA==",
      bytes: 1,
      owners: ["a"],
      usedAt: 1,
    };
    reserveSlots(s, [hash], new Set(s.slots.map((v) => v.slot)), 1);
  }
  const hash = "f".repeat(64);
  s.assets[hash] = {
    hash,
    type: "anim",
    data: "AA==",
    bytes: 1,
    owners: ["a"],
    usedAt: 1,
  };
  expect(() => reserveSlots(s, [hash], new Set(), 2)).toThrow("SLOT_CAPACITY");
});
