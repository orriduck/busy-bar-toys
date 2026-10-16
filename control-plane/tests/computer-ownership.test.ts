import { describe, expect, it } from "vitest";
import { createState, registerService } from "../src/model";
import * as ownership from "../src/computers";
const now = 1_800_000_000_000;
function state() {
  const s = createState("device");
  s.sessions.browser = s.sessions.peer = now + 3600_000;
  return s;
}
function enrolled(s = state(), id = "computer-a", session = "browser") {
  ownership.beginEnrollment(s, session, "ticket-" + id, id, now);
  ownership.redeemEnrollment(s, "ticket-" + id, "secret-" + id, now);
  return s;
}
function unchanged(
  s: ReturnType<typeof state>,
  work: () => unknown,
  code: string,
) {
  const before = structuredClone(s);
  expect(work).toThrow(code);
  expect(s).toEqual(before);
}
describe("verified computer enrollment", () => {
  it("binds only the initiating live session after one-time redemption", () => {
    const s = state();
    ownership.beginEnrollment(s, "browser", "ticket", "computer-a", now);
    expect(ownership.sessionComputer(s, "browser")).toBeNull();
    expect(ownership.redeemEnrollment(s, "ticket", "hash", now + 1).id).toBe(
      "computer-a",
    );
    expect(ownership.sessionComputer(s, "browser")).toBe("computer-a");
    expect(ownership.sessionComputer(s, "peer")).toBeNull();
    unchanged(
      s,
      () => ownership.redeemEnrollment(s, "ticket", "other", now + 2),
      "ENROLLMENT_INVALID",
    );
  });
  it.each(["expired-ticket", "expired-session"])(
    "rejects %s without issuing credentials",
    (kind) => {
      const s = state();
      ownership.beginEnrollment(s, "browser", "ticket", "a", now);
      if (kind === "expired-session") s.sessions.browser = now + 1;
      unchanged(
        s,
        () =>
          ownership.redeemEnrollment(
            s,
            "ticket",
            "hash",
            kind === "expired-ticket" ? now + 300_000 : now + 2,
          ),
        "ENROLLMENT_INVALID",
      );
    },
  );
  it("rejects existing identities and silently switching a bound browser", () => {
    const s = enrolled();
    unchanged(
      s,
      () => ownership.beginEnrollment(s, "peer", "ticket", "computer-a", now),
      "COMPUTER_EXISTS",
    );
    unchanged(
      s,
      () =>
        ownership.beginEnrollment(s, "browser", "ticket", "computer-b", now),
      "COMPUTER_ALREADY_BOUND",
    );
  });
  it("requires a live session and bounds pending enrollment", () => {
    const s = state();
    unchanged(
      s,
      () => ownership.beginEnrollment(s, "missing", "ticket", "a", now),
      "UNAUTHORIZED",
    );
    for (let i = 0; i < 16; i++) {
      s.sessions["s" + i] = now + 3600_000;
      ownership.beginEnrollment(s, "s" + i, "t" + i, "c" + i, now);
    }
    unchanged(
      s,
      () =>
        ownership.beginEnrollment(s, "browser", "overflow", "overflow", now),
      "ENROLLMENT_CAPACITY",
    );
  });
});
describe("single-use browser pairing", () => {
  it("binds to the verified issuer and consumes the code", () => {
    const s = enrolled();
    ownership.issuePairing(s, "computer-a", "pair", now);
    ownership.redeemPairing(s, "peer", "pair", now + 1);
    expect(ownership.sessionComputer(s, "peer")).toBe("computer-a");
    unchanged(
      s,
      () => ownership.redeemPairing(s, "peer", "pair", now + 2),
      "PAIRING_INVALID",
    );
  });
  it.each(["expired", "revoked", "signed-out"])(
    "rejects %s pairing without mutation",
    (kind) => {
      const s = enrolled();
      ownership.issuePairing(s, "computer-a", "pair", now);
      if (kind === "revoked") s.computers["computer-a"].revokedAt = now + 1;
      if (kind === "signed-out") delete s.sessions.peer;
      unchanged(
        s,
        () =>
          ownership.redeemPairing(
            s,
            "peer",
            "pair",
            kind === "expired" ? now + 300_000 : now + 2,
          ),
        "PAIRING_INVALID",
      );
    },
  );
  it("cannot silently replace a paired computer", () => {
    const s = enrolled();
    enrolled(s, "computer-b", "peer");
    ownership.issuePairing(s, "computer-a", "pair", now);
    unchanged(
      s,
      () => ownership.redeemPairing(s, "peer", "pair", now),
      "COMPUTER_ALREADY_BOUND",
    );
  });
});
function legacy() {
  const s = state();
  registerService(
    s,
    { id: "agent", name: "Agent", template: "agent" },
    "agent-hash",
    "epoch",
    now,
  );
  registerService(
    s,
    {
      id: "notifier",
      name: "Notifier",
      template: "notifier",
      computerId: s.services.agent.computerId,
    },
    "notifier-hash",
    "epoch",
    now,
  );
  return s;
}
describe("service ownership and legacy enrollment", () => {
  it("claims exactly one legacy computer with all live publisher proofs, once", () => {
    const s = legacy();
    const id = s.services.agent.computerId!;
    const proof = { agent: "agent-hash", notifier: "notifier-hash" };
    expect(
      ownership.claimLegacy(s, "agent", proof, "management-hash", now),
    ).toMatchObject({
      id,
      credentialHash: "management-hash",
      serviceOrder: ["agent", "notifier"],
    });
    unchanged(
      s,
      () => ownership.claimLegacy(s, "agent", proof, "second", now),
      "COMPUTER_ALREADY_ENROLLED",
    );
  });
  it.each(["incomplete", "wrong", "extra", "expired"])(
    "rejects %s proof set without mutation",
    (kind) => {
      const s = legacy();
      const proof: Record<string, string> = {
        agent: "agent-hash",
        notifier: "notifier-hash",
      };
      if (kind === "incomplete") delete proof.notifier;
      if (kind === "wrong") proof.notifier = "incorrect";
      if (kind === "extra") proof.foreign = "foreign-hash";
      if (kind === "expired") s.services.notifier.epochExpiresAt = now;
      unchanged(
        s,
        () => ownership.claimLegacy(s, "agent", proof, "management-hash", now),
        "COMPUTER_PROOF_REQUIRED",
      );
    },
  );
  it("allows all owned service IDs but denies foreign, missing and inherited IDs", () => {
    const s = legacy();
    const id = s.services.agent.computerId!;
    ownership.claimLegacy(
      s,
      "agent",
      { agent: "agent-hash", notifier: "notifier-hash" },
      "hash",
      now,
    );
    registerService(
      s,
      { id: "foreign", name: "Peer", template: "custom" },
      "other",
      "epoch",
      now,
    );
    expect(ownership.ownedService(s, id, "agent").id).toBe("agent");
    expect(ownership.ownedService(s, id, "notifier").id).toBe("notifier");
    for (const target of ["foreign", "missing", "constructor", "__proto__"])
      unchanged(
        s,
        () => ownership.ownedService(s, id, target),
        "SERVICE_NOT_OWNED",
      );
    s.computers[id].revokedAt = now;
    unchanged(
      s,
      () => ownership.ownedService(s, id, "agent"),
      "COMPUTER_REVOKED",
    );
  });
});

describe("owned service order", () => {
  it("changes only the owner's order, without writing numeric priorities", () => {
    const s = legacy(),
      id = s.services.agent.computerId!;
    ownership.claimLegacy(
      s,
      "agent",
      { agent: "agent-hash", notifier: "notifier-hash" },
      "hash",
      now,
    );
    const configs = structuredClone(
      Object.values(s.services).map((service) => service.config),
    );
    const revision = s.configRevision;
    ownership.reorderOwnedServices(s, id, ["notifier", "agent"], revision);
    expect(s.computers[id].serviceOrder).toEqual(["notifier", "agent"]);
    expect(Object.values(s.services).map((service) => service.config)).toEqual(
      configs,
    );
    expect(s.configRevision).toBe(revision + 1);
  });
  it.each(
    [
      ["agent"],
      ["agent", "agent"],
      ["agent", "foreign"],
      ["notifier", "agent", "foreign"],
    ].map((ids) => ({ ids })),
  )("rejects foreign or incomplete permutations $ids", ({ ids }) => {
    const s = legacy(),
      id = s.services.agent.computerId!;
    ownership.claimLegacy(
      s,
      "agent",
      { agent: "agent-hash", notifier: "notifier-hash" },
      "hash",
      now,
    );
    unchanged(
      s,
      () => ownership.reorderOwnedServices(s, id, ids, s.configRevision),
      "INVALID_SERVICE_ORDER",
    );
    unchanged(
      s,
      () =>
        ownership.reorderOwnedServices(
          s,
          id,
          ["notifier", "agent"],
          s.configRevision - 1,
        ),
      "CONFIG_CONFLICT",
    );
  });
});

it("counts outstanding enrollment reservations when claiming a legacy computer", () => {
  const s = legacy();
  for (let i = 0; i < 31; i++)
    s.computers["existing-" + i] = {
      id: "existing-" + i,
      credentialHash: "hash",
      createdAt: now,
      serviceOrder: [],
    };
  ownership.beginEnrollment(s, "browser", "reserved", "reserved-computer", now);
  unchanged(
    s,
    () =>
      ownership.claimLegacy(
        s,
        "agent",
        { agent: "agent-hash", notifier: "notifier-hash" },
        "management",
        now,
      ),
    "COMPUTER_CAPACITY",
  );
});
