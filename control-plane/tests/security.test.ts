import { it, expect, vi } from "vitest";
import { BusyClient, allowRequest } from "../src/busy";
import {
  encrypt,
  decrypt,
  digest,
  signSession,
  verifySession,
} from "../src/security";
import { cacheAsset, reserveSlots } from "../src/assets";
import { createState, ProtocolError } from "../src/model";
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

it("bootstraps a fresh namespace once and waits for the final scoped clear ACK", async () => {
  const calls: Request[] = [];
  let release: (response: Response) => void = () => {};
  const finalAck = new Promise<Response>((resolve) => (release = resolve));
  let entered: () => void = () => {};
  const finalClearEntered = new Promise<void>((resolve) => (entered = resolve));
  const client = new BusyClient("fake", {
    fetch: async (request: Request) => {
      calls.push(request);
      if (calls.length === 1)
        return new Response("private upstream error", { status: 400 });
      if (calls.length === 2) return Response.json({ result: "OK" });
      entered();
      return finalAck;
    },
  } as Pick<Fetcher, "fetch">);
  let settled = false;
  const result = client
    .request("DELETE", "/display/draw?application_name=busy-control")
    .finally(() => (settled = true));
  try {
    await Promise.race([finalClearEntered, result]);
    expect(calls.map((request) => request.method)).toEqual([
      "DELETE",
      "POST",
      "DELETE",
    ]);
    expect(calls[0].url).toBe(calls[2].url);
    expect(await calls[1].json()).toEqual({
      application_name: "busy-control",
      priority: 51,
      elements: [
        {
          id: "control-init",
          type: "rectangle",
          display: "front",
          color: "#00000000",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          opacity: 0,
          timeout: 1,
        },
      ],
    });
    expect(settled).toBe(false);
  } finally {
    release(Response.json({ result: "OK" }));
    await result.catch(() => {});
  }
  expect(await result).toEqual({ result: "OK" });
});

it("does not swallow or recursively bootstrap a failed final clear, and never logs its body", async () => {
  const calls: string[] = [];
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const client = new BusyClient("fake", {
    fetch: async (request: Request) => {
      calls.push(request.method);
      return request.method === "POST"
        ? Response.json({ result: "OK" })
        : new Response("private-secret-upstream-body", { status: 400 });
    },
  } as Pick<Fetcher, "fetch">);
  try {
    await expect(
      client.request("DELETE", "/display/draw?application_name=busy-control"),
    ).rejects.toThrow("UPSTREAM_FAILURE");
    expect(calls).toEqual(["DELETE", "POST", "DELETE"]);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-secret");
  } finally {
    warning.mockRestore();
  }
});

it("reports a blocked namespace bootstrap without retrying the clear", async () => {
  const calls: string[] = [];
  const client = new BusyClient("fake", {
    fetch: async (request: Request) => {
      calls.push(request.method);
      return new Response("private error", {
        status: request.method === "DELETE" ? 400 : 409,
      });
    },
  } as Pick<Fetcher, "fetch">);
  await expect(
    client.request("DELETE", "/display/draw?application_name=busy-control"),
  ).rejects.toThrow("DEVICE_BLOCKED");
  expect(calls).toEqual(["DELETE", "POST"]);
});

it("never bootstraps or widens a selective clear rejected with400", async () => {
  const calls: Request[] = [];
  const client = new BusyClient("fake", {
    fetch: async (request: Request) => {
      calls.push(request);
      return new Response("private error", { status: 400 });
    },
  } as Pick<Fetcher, "fetch">);
  const payload = { application_name: "busy-control", element_ids: ["mask"] };
  await expect(
    client.request(
      "DELETE",
      "/display/draw?application_name=busy-control",
      payload,
    ),
  ).rejects.toThrow("UPSTREAM_FAILURE");
  expect(calls).toHaveLength(1);
  expect(await calls[0].json()).toEqual(payload);
});

it("fixes native cloud priority at51 and rejects legacy or arbitrary priorities", async () => {
  const calls: Request[] = [];
  const client = new BusyClient("fake", {
    fetch: async (request: Request) => {
      calls.push(request);
      return Response.json({ result: "OK" });
    },
  } as Pick<Fetcher, "fetch">);
  const payload = {
    application_name: "busy-control",
    priority: 51,
    elements: [
      { id: "text", type: "text", text: "Hi", font: "small", timeout: 1 },
    ],
  };
  await client.request("POST", "/display/draw", payload);
  for (const priority of [50, 52, 100])
    await expect(
      client.request("POST", "/display/draw", { ...payload, priority }),
    ).rejects.toThrow("DEVICE_DRAW_PARAMS");
  expect(calls).toHaveLength(1);
});

it("uses one abort controller for all three namespace recovery calls", async () => {
  const OriginalController = globalThis.AbortController;
  const controllers: AbortController[] = [];
  vi.stubGlobal(
    "AbortController",
    class extends OriginalController {
      constructor() {
        super();
        controllers.push(this);
      }
    },
  );
  const signals: AbortSignal[] = [];
  const client = new BusyClient("fake", {
    fetch: async (request: Request) => {
      signals.push(request.signal);
      return signals.length === 1
        ? new Response("private error", { status: 400 })
        : Response.json({ result: "OK" });
    },
  } as Pick<Fetcher, "fetch">);
  try {
    await client.request(
      "DELETE",
      "/display/draw?application_name=busy-control",
    );
    expect(signals).toHaveLength(3);
    expect(controllers).toHaveLength(1);
    controllers[0].abort();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(["bootstrap", "retry"] as const)(
  "ends the entire recovery at8 seconds before the next %s write",
  async (boundary) => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let release: (response: Response) => void = () => {};
    const heldResponse = new Promise<Response>((r) => (release = r));
    let entered: () => void = () => {};
    const heldCallEntered = new Promise<void>((r) => (entered = r));
    const client = new BusyClient("fake", {
      fetch: async (request: Request) => {
        signals.push(request.signal);
        if (
          (boundary === "bootstrap" && signals.length === 1) ||
          (boundary === "retry" && signals.length === 2)
        ) {
          entered();
          return heldResponse;
        }
        return signals.length === 1
          ? new Response("private error", { status: 400 })
          : Response.json({ result: "OK" });
      },
    } as Pick<Fetcher, "fetch">);
    const pending = client.request(
      "DELETE",
      "/display/draw?application_name=busy-control",
    );
    const failed = expect(pending).rejects.toThrow("UPSTREAM_UNAVAILABLE");
    try {
      await heldCallEntered;
      await vi.advanceTimersByTimeAsync(8000);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      release(
        boundary === "bootstrap"
          ? new Response("private error", { status: 400 })
          : Response.json({ result: "OK" }),
      );
      await failed;
      expect(signals).toHaveLength(boundary === "bootstrap" ? 1 : 2);
    } finally {
      release(Response.json({ result: "OK" }));
      await pending.catch(() => {});
      vi.useRealTimers();
    }
  },
);

it.each([1, 2])(
  "checks generation before the write following response%d",
  async (switchAfter) => {
    let current = true;
    const methods: string[] = [];
    const client = new BusyClient(
      "fake",
      {
        fetch: async (request: Request) => {
          methods.push(request.method);
          if (methods.length === switchAfter) current = false;
          return methods.length === 1
            ? new Response("private error", { status: 400 })
            : Response.json({ result: "OK" });
        },
      } as Pick<Fetcher, "fetch">,
      () => {
        if (!current) throw new ProtocolError("STALE_TARGET", 409);
      },
    );
    await expect(
      client.request("DELETE", "/display/draw?application_name=busy-control"),
    ).rejects.toThrow("STALE_TARGET");
    expect(methods).toEqual(
      switchAfter === 1 ? ["DELETE"] : ["DELETE", "POST"],
    );
  },
);
