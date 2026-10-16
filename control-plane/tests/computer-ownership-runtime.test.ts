import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createState, registerService } from "../src/model";
import { StateStore } from "../src/store";
import { digest, signSession } from "../src/security";
import { beginEnrollment, redeemEnrollment } from "../src/computers";
const origin = "https://control.test";
async function setup() {
  const deviceId = await digest(crypto.randomUUID()),
    expiresAt = Date.now() + 3600_000;
  const stub = env.DEVICES.getByName(deviceId);
  const ownerSecret = "a".repeat(43),
    peerSecret = "b".repeat(43);
  const hashes = await Promise.all([digest(ownerSecret), digest(peerSecret)]);
  await runInDurableObject(stub, (_instance, ctx) => {
    const s = createState(deviceId),
      now = Date.now();
    s.sessions.owner = s.sessions.peer = s.sessions.viewer = expiresAt;
    for (const [index, computer] of ["computer-a", "computer-b"].entries()) {
      const session = index ? "peer" : "owner";
      beginEnrollment(s, session, "ticket-" + computer, computer, now);
      redeemEnrollment(s, "ticket-" + computer, hashes[index], now);
    }
    registerService(
      s,
      { id: "github", name: "GitHub", template: "notifier" },
      "old-github",
      "epoch",
      now,
    );
    registerService(
      s,
      { id: "datadog", name: "Datadog", template: "notifier" },
      "old-dd",
      "epoch",
      now,
    );
    registerService(
      s,
      { id: "foreign", name: "Peer", template: "notifier" },
      "old-peer",
      "epoch",
      now,
    );
    s.services.github.computerId = s.services.datadog.computerId = "computer-a";
    s.services.foreign.computerId = "computer-b";
    s.computers["computer-a"].serviceOrder = ["github", "datadog"];
    s.computers["computer-b"].serviceOrder = ["foreign"];
    new StateStore(ctx.storage).save(s);
  });
  const cookies = Object.fromEntries(
    await Promise.all(
      ["owner", "peer", "viewer"].map(async (id) => [
        id,
        "busy_session=" +
          encodeURIComponent(
            await signSession(
              { deviceId, id, expiresAt },
              env.SESSION_SIGNING_KEY,
            ),
          ),
      ]),
    ),
  );
  const call = (
    path: string,
    body?: unknown,
    options: {
      session?: string;
      credential?: string;
      service?: string;
      method?: string;
    } = {},
  ) =>
    exports.default.fetch(origin + path, {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(options.credential
          ? { Authorization: "Bearer " + options.credential }
          : {
              Cookie: cookies[options.session ?? "owner"],
              "X-Busy-Device": deviceId,
            }),
        ...(options.service ? { "X-Busy-Service": options.service } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const read = () =>
    runInDurableObject(stub, (_instance, ctx) =>
      new StateStore(ctx.storage).load()!,
    );
  return {
    call,
    read,
    stub,
    credential: `${deviceId}.c.computer-a.${ownerSecret}`,
  };
}
describe("server-enforced computer service ownership", () => {
  it.each(["viewer", "peer"])(
    "rejects %s browser config writes without changing persisted state",
    async (session) => {
      const { call, read } = await setup();
      const before = await read();
      const r = await call(
        "/api/services/github",
        {
          expectedRevision: before.configRevision,
          config: { visibleMs: 20000 },
        },
        { session, method: "PATCH" },
      );
      expect(r.status).toBe(403);
      expect(await read()).toEqual(before);
    },
  );
  it("allows its owner while denying registration under a forged computer ID", async () => {
    const { call, read } = await setup();
    let s = await read();
    expect(
      (
        await call(
          "/api/services/github",
          { expectedRevision: s.configRevision, config: { visibleMs: 20000 } },
          { method: "PATCH" },
        )
      ).status,
    ).toBe(200);
    s = await read();
    expect(s.services.github.config.visibleMs).toBe(20000);
    const before = structuredClone(s);
    expect(
      (
        await call("/api/services", {
          id: "spoof",
          name: "Spoof",
          template: "custom",
          computerId: "computer-b",
          expectedRevision: s.configRevision,
        })
      ).status,
    ).toBe(403);
    expect(await read()).toEqual(before);
  });
  it.each(["revoke", "credential", "remove"])(
    "blocks cross-computer %s before mutation",
    async (action) => {
      const { call, read } = await setup();
      const before = await read();
      expect(
        (
          await call(`/api/services/foreign/${action}`, {
            expectedRevision: before.configRevision,
          })
        ).status,
      ).toBe(403);
      expect(await read()).toEqual(before);
    },
  );
  it("one computer sender can publish arbitrary app labels to either owned registered ID", async () => {
    const { call, read, credential } = await setup();
    for (const service of ["github", "datadog"]) {
      const r = await call(
        "/api/publish",
        {
          serviceId: service,
          instanceId: "local-notifier",
          epoch: "epoch",
          itemId: "one",
          version: 1,
          firstRecognizedAt: Date.now(),
          kind: "event",
          level: "info",
          app: "local-choice",
          title: "Synthetic test",
          validUntil: Date.now() + 10000,
          scene: {
            entryDurationMs: 0,
            commands: [
              {
                offsetMs: 0,
                elements: [
                  { id: "text", type: "text", text: "TEST", font: "small" },
                ],
              },
            ],
          },
        },
        { credential, service },
      );
      expect(r.status).toBe(200);
    }
    expect(
      Object.values((await read()).items)
        .map((i) => i.serviceId)
        .sort(),
    ).toEqual(["datadog", "github"]);
  });
  it("denies a foreign or absent publication target with the same computer credential", async () => {
    const { call, read, credential } = await setup();
    const before = await read();
    expect(
      (await call("/api/publish", {}, { credential, service: "foreign" }))
        .status,
    ).toBe(403);
    expect((await call("/api/publish", {}, { credential })).status).toBe(403);
    expect(await read()).toEqual(before);
  });
  it("returns verified session ownership independently from public snapshots", async () => {
    const { call } = await setup();
    expect(await (await call("/api/session")).json()).toMatchObject({
      computerId: "computer-a",
    });
    expect(
      await (
        await call("/api/session", undefined, { session: "viewer" })
      ).json(),
    ).toMatchObject({ computerId: null });
    const snapshot = await (await call("/api/snapshot")).text();
    expect(snapshot).not.toContain("credentialHash");
    expect(snapshot).not.toContain("secret-");
  });
});

describe("computer enrollment and pairing HTTP lifecycle", () => {
  it("enrolls a new local computer once and binds only its initiating browser", async () => {
    const { call } = await setup();
    const ticketResponse = await call(
      "/api/computers/enrollment",
      {},
      { session: "viewer" },
    );
    expect(ticketResponse.status).toBe(201);
    const ticket = (await ticketResponse.json()) as {
      enrollment: string;
      computerId: string;
    };
    const enrolled = await call(
      "/api/computers/enroll",
      { managementSecret: "c".repeat(43) },
      { credential: ticket.enrollment },
    );
    expect(enrolled.status).toBe(201);
    const result = (await enrolled.json()) as {
      credential: string;
      computerId: string;
    };
    expect(result.computerId).toBe(ticket.computerId);
    expect(result).not.toHaveProperty("credential");
    const localCredential = `${ticket.enrollment.split(".")[1]}.c.${ticket.computerId}.${"c".repeat(43)}`;
    expect(
      (await call("/api/snapshot", undefined, { credential: localCredential }))
        .status,
    ).toBe(200);
    expect(
      await (
        await call("/api/session", undefined, { session: "viewer" })
      ).json(),
    ).toMatchObject({ computerId: ticket.computerId });
    expect(
      (
        await call(
          "/api/computers/enroll",
          { managementSecret: "c".repeat(43) },
          { credential: ticket.enrollment },
        )
      ).status,
    ).toBe(403);
    expect(
      (await call("/api/computers/enrollment", {}, { session: "viewer" }))
        .status,
    ).toBe(409);
  });
  it("pairs a monitoring browser using a code issued by its computer, once", async () => {
    const { call, credential } = await setup();
    const issued = await call("/api/computers/pairing", {}, { credential });
    expect(issued.status).toBe(201);
    const { code } = (await issued.json()) as { code: string };
    expect(
      (await call("/api/session/computer", { code }, { session: "viewer" }))
        .status,
    ).toBe(200);
    expect(
      await (
        await call("/api/session", undefined, { session: "viewer" })
      ).json(),
    ).toMatchObject({ computerId: "computer-a" });
    expect(
      (await call("/api/session/computer", { code }, { session: "viewer" }))
        .status,
    ).toBe(403);
  });
});

describe("ownership transport boundary regressions", () => {
  it("expires unused enrollment and pairing codes through the alarm", async () => {
    const { call, stub } = await setup();
    expect(
      (await call("/api/computers/enrollment", {}, { session: "viewer" }))
        .status,
    ).toBe(201);
    await runInDurableObject(stub, async (instance, ctx) => {
      const store = new StateStore(ctx.storage),
        s = store.load()!;
      for (const code of Object.values(s.enrollments))
        code.expiresAt = Date.now() - 1;
      store.save(s);
      await instance.alarm();
      const after = new StateStore(ctx.storage).load()!;
      expect(Object.keys(after.enrollments)).toEqual([]);
      expect((await ctx.storage.getAlarm()) ?? Infinity).toBeGreaterThan(
        Date.now() + 100,
      );
    });
  });
  it("does not accept browser requests impersonating a physical device button", async () => {
    const { call, read } = await setup();
    const before = await read();
    expect(
      (
        await call("/api/input", {
          instanceId: "browser",
          button: "start_pause",
          eventId: "fake",
          generation: before.generation,
        })
      ).status,
    ).toBe(403);
    expect(await read()).toEqual(before);
  });
  it("supports computer credentials for an explicitly authorized preview publisher", async () => {
    const { stub, read, credential } = await setup();
    await runInDurableObject(stub, (_instance, ctx) => {
      const store = new StateStore(ctx.storage),
        s = store.load()!;
      s.services.github.config.allowPreview = true;
      store.save(s);
    });
    const r = await exports.default.fetch(origin + "/api/preview/publish", {
      headers: {
        Authorization: "Bearer " + credential,
        "X-Busy-Service": "github",
        "X-Busy-Instance": "local",
        "X-Busy-Epoch": "epoch",
        Upgrade: "websocket",
      },
    });
    expect(r.status).toBe(101);
    r.webSocket!.accept();
    r.webSocket!.close(1000, "test complete");
    expect((await read()).services.github.computerId).toBe("computer-a");
  });
});

it("can use its pre-saved management credential even if a legacy claim response is lost", async () => {
  const { call, stub, credential } = await setup(),
    deviceId = credential.split(".")[0];
  const githubSecret = "g".repeat(43),
    ddSecret = "d".repeat(43),
    managementSecret = "m".repeat(43);
  const githubHash = await digest(githubSecret),
    ddHash = await digest(ddSecret);
  await runInDurableObject(stub, (_instance, ctx) => {
    const store = new StateStore(ctx.storage),
      s = store.load()!;
    delete s.computers["computer-a"];
    delete s.sessionComputers.owner;
    s.services.github.credentialHash = githubHash;
    s.services.datadog.credentialHash = ddHash;
    store.save(s);
  });
  const oldGithub = `${deviceId}.github.${githubSecret}`,
    oldDatadog = `${deviceId}.datadog.${ddSecret}`;
  const claim = await call(
    "/api/computers/claim",
    { proofs: { github: oldGithub, datadog: oldDatadog }, managementSecret },
    { credential: oldGithub },
  );
  expect(claim.status).toBe(201);
  expect(await claim.json()).not.toHaveProperty("credential");
  const saved = `${deviceId}.c.computer-a.${managementSecret}`;
  expect(
    (await call("/api/snapshot", undefined, { credential: saved })).status,
  ).toBe(200);
  expect(
    (
      await call(
        "/api/computers/claim",
        {
          proofs: { github: oldGithub, datadog: oldDatadog },
          managementSecret,
        },
        { credential: oldGithub },
      )
    ).status,
  ).toBe(409);
  expect(
    (await call("/api/snapshot", undefined, { credential: saved })).status,
  ).toBe(200);
});

it("returns its authenticated computer identity and only its owned registrations to a local client", async () => {
  const { call, credential } = await setup();
  const r = await call("/api/computer", undefined, { credential });
  expect(r.status).toBe(200);
  const value = (await r.json()) as {
    computerId: string;
    services: { id: string }[];
  };
  expect(value.computerId).toBe("computer-a");
  expect(value.services.map((s) => s.id).sort()).toEqual(["datadog", "github"]);
  expect((await call("/api/computer")).status).toBe(403);
});

describe("global priority group mutation HTTP boundary", () => {
  it("saves exactly the owner's complete groups and leaves foreign configuration untouched", async () => {
    const { call, read } = await setup();
    const before = await read();
    const result = await call("/api/services/order", {
      expectedRevision: before.configRevision,
      groups: {
        interception: ["datadog"],
        "follow-queue": [],
        dispensable: ["github"],
      },
    });
    expect(result.status).toBe(200);
    const after = await read();
    expect(after.services.datadog.priorityGroup).toBe("interception");
    expect(after.services.github.priorityGroup).toBe("dispensable");
    expect(after.services.foreign).toEqual(before.services.foreign);
    expect(after.computers["computer-a"].serviceOrder).toEqual([
      "datadog",
      "github",
    ]);
    expect(after.services.github.credentialHash).toBe(
      before.services.github.credentialHash,
    );
    expect(
      (
        await call("/api/services/order", {
          expectedRevision: after.configRevision,
          serviceIds: ["github", "datadog"],
        })
      ).status,
    ).toBe(200);
    expect((await read()).services.datadog.priorityGroup).toBe("interception");
  });
  it("rejects malformed, incomplete, duplicate, foreign, and revision-conflicted groups before persistence", async () => {
    const { call, read } = await setup();
    for (const groups of [
      null,
      [],
      {},
      {
        interception: ["github"],
        "follow-queue": ["foreign"],
        dispensable: [],
      },
      { interception: ["github"], "follow-queue": ["github"], dispensable: [] },
      { interception: ["github"], "follow-queue": [], dispensable: [] },
      {
        interception: ["github", "datadog"],
        "follow-queue": [],
        dispensable: [],
        unexpected: [],
      },
    ]) {
      const before = await read();
      expect(
        (
          await call("/api/services/order", {
            expectedRevision: before.configRevision,
            groups,
          })
        ).status,
      ).toBe(400);
      expect(await read()).toEqual(before);
    }
    const before = await read();
    expect(
      (
        await call("/api/services/order", {
          expectedRevision: before.configRevision - 1,
          groups: {
            interception: ["github", "datadog"],
            "follow-queue": [],
            dispensable: [],
          },
        })
      ).status,
    ).toBe(409);
    expect(await read()).toEqual(before);
  });
});
