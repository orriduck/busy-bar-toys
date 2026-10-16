import { describe, it, expect } from "vitest";
import * as m from "../src/model";
const now = 1800000000000;
function setup() {
  const s = m.createState("d");
  for (const [id, pc, order] of [
    ["a", "A", ["a", "low"]],
    ["low", "A", ["a", "low"]],
    ["b", "B", ["b", "peer"]],
    ["peer", "B", ["b", "peer"]],
  ] as const) {
    m.registerService(s, { id, name: id, template: "agent" }, "h", "e", now);
    s.services[id].computerId = pc;
    s.computers[pc] = {
      id: pc,
      credentialHash: "h",
      createdAt: now,
      serviceOrder: [...order],
    };
    s.services[id].config.visibleMs = id === "peer" ? 7000 : 5000;
  }
  return s;
}
function send(
  s: m.State,
  id: string,
  at = now,
  extra: Record<string, unknown> = {},
) {
  return m.publish(
    s,
    id,
    {
      epoch: "e",
      instanceId: "mac",
      itemId: id,
      version: 1,
      kind: "agent",
      level: "info",
      title: id,
      validUntil: now + 200000,
      scene: {
        entryDurationMs: 0,
        commands: [
          {
            offsetMs: 0,
            elements: [{ id: "t", type: "text", text: id, font: "small" }],
          },
        ],
      },
      ...extra,
    },
    at,
  );
}
const active = (s: m.State) =>
  s.selected ? s.items[s.selected]?.serviceId : null;
describe("global priority groups and confirmed visible-time turns", () => {
  it("preempts another computer lower group and resumes its exact occurrence", () => {
    const s = setup();
    s.services.b.priorityGroup = "interception";
    const low = send(s, "low");
    m.acceptDisplay(s, s.generation, now);
    send(s, "b", now + 2000);
    expect(active(s)).toBe("b");
    m.finishItem(s, s.selected!, "resolved", 1, now + 3000);
    expect(s.selected).toBe(low.itemKey);
    expect(s.items[low.itemKey].remainingMs).toBeNull();
  });
  it("alternates Dispensable computers using each Hold without ending their sources", () => {
    const s = setup();
    send(s, "low");
    m.acceptDisplay(s, s.generation, now);
    send(s, "peer");
    m.tick(s, now + 5000);
    expect(active(s)).toBe("peer");
    expect(Object.keys(s.tombstones)).toHaveLength(0);
    m.acceptDisplay(s, s.generation, now + 5000);
    m.tick(s, now + 11999);
    expect(active(s)).toBe("peer");
    m.tick(s, now + 12000);
    expect(active(s)).toBe("low");
  });
  it("preserves a partial turn across a higher group interruption", () => {
    const s = setup();
    s.services.b.priorityGroup = "interception";
    send(s, "low");
    m.acceptDisplay(s, s.generation, now);
    send(s, "peer");
    send(s, "b", now + 2000);
    m.acceptDisplay(s, s.generation, now + 2000);
    m.finishItem(s, s.selected!, "resolved", 1, now + 4000);
    expect(active(s)).toBe("low");
    m.acceptDisplay(s, s.generation, now + 4000);
    m.tick(s, now + 6999);
    expect(active(s)).toBe("low");
    m.tick(s, now + 7000);
    expect(active(s)).toBe("peer");
  });
  it("does not charge unconfirmed entrance or time past native confirmation", () => {
    const s = setup();
    send(s, "low", now, {
      scene: {
        entryDurationMs: 1000,
        commands: [
          {
            offsetMs: 0,
            elements: [{ id: "t", type: "text", text: "low", font: "small" }],
          },
        ],
      },
    });
    send(s, "peer");
    m.tick(s, now + 10000);
    expect(active(s)).toBe("low");
    m.acceptDisplay(s, s.generation, now + 10000);
    s.displaying!.confirmedValidUntil = now + 13000;
    s.health.confirmedValidUntil = now + 13000;
    m.tick(s, now + 20000);
    expect(active(s)).toBe("low");
    m.acceptDisplay(s, s.generation, now + 20000);
    m.tick(s, now + 22999);
    expect(active(s)).toBe("low");
    m.tick(s, now + 23000);
    expect(active(s)).toBe("peer");
  });
  it("keeps a source alive alone, yields when a peer arrives, and survives persisted reload", () => {
    let s = setup();
    send(s, "low");
    m.acceptDisplay(s, s.generation, now);
    m.tick(s, now + 6000);
    const generation = s.generation;
    m.tick(s, now + 7000);
    expect(s.generation).toBe(generation);
    s = JSON.parse(JSON.stringify(s));
    send(s, "peer", now + 8000);
    expect(active(s)).toBe("peer");
    expect(Object.keys(s.items)).toHaveLength(2);
  });
  it("exposes Hold ETA for every equal service including a later same-computer source", () => {
    const s = setup();
    send(s, "a");
    m.acceptDisplay(s, s.generation, now);
    send(s, "b");
    send(s, "low");
    const view = m.snapshot(s, now + 2000);
    const playing = view.items.find((i) => i.serviceId === "a")!;
    expect(playing.playback.totalMs).toBe(5000);
    expect(playing.playback.remainingMs).toBe(3000);
    expect(view.items.find((i) => i.serviceId === "b")?.eta).toEqual({
      kind: "estimate",
      at: now + 5000,
    });
    expect(view.items.find((i) => i.serviceId === "low")?.eta).toEqual({
      kind: "estimate",
      at: now + 10000,
    });
  });
  it("records idle source heartbeats without deriving online status from global health", () => {
    const s = setup();
    m.heartbeat(
      s,
      "a",
      { epoch: "e", instanceId: "mac", itemIds: [], validUntil: now + 10000 },
      now,
    );
    expect(
      m.snapshot(s, now).services.find((x) => x.id === "a"),
    ).toHaveProperty("lastHeartbeatAt", now);
    expect(
      m.snapshot(s, now).services.find((x) => x.id === "b"),
    ).not.toHaveProperty("lastHeartbeatAt");
  });
});

it("content revisions and heartbeats preserve the turn; finite lifetime survives a shorter new Hold", () => {
  const s = setup();
  s.services.low.config.visibleMs = 10000;
  const item = send(s, "low", now, { kind: "event", exit: "finite" });
  m.acceptDisplay(s, s.generation, now);
  s.services.low.config.visibleMs = 5000;
  send(s, "peer");
  send(s, "low", now + 2000, {
    kind: "event",
    exit: "finite",
    version: 2,
    title: "updated",
  });
  m.heartbeat(
    s,
    "low",
    {
      epoch: "e",
      instanceId: "mac",
      itemIds: ["low"],
      validUntil: now + 60000,
    },
    now + 4000,
  );
  s.admission = s.admission.map((a) => ({ ...a, version: 2 })); // successful content ACK
  m.tick(s, now + 10000);
  expect(s.tombstones[item.itemKey]?.reason).toBe("completed");
  expect(active(s)).toBe("peer");
});
it("queues one turn per service before that service next independent message", () => {
  const s = setup();
  send(s, "a", now, { kind: "event", exit: "finite" });
  m.acceptDisplay(s, s.generation, now);
  send(s, "a", now, { itemId: "second", kind: "event", exit: "finite" });
  send(s, "b");
  expect(m.groups(s).map((g) => g.representative.itemId)).toEqual([
    "a",
    "b",
    "second",
  ]);
  m.tick(s, now + 5000);
  expect(active(s)).toBe("b");
});

it("does not promise a Follow queue ETA past a source-ended occurrence", () => {
  const s = setup();
  s.services.a.priorityGroup = s.services.b.priorityGroup = "follow-queue";
  send(s, "a");
  m.acceptDisplay(s, s.generation, now);
  send(s, "b", now + 4000, { kind: "event", exit: "finite" });
  expect(
    m.snapshot(s, now + 4000).items.find((i) => i.serviceId === "b")?.eta.kind,
  ).toBe("await-resolution");
});

it("rotates same-computer services and resumes a partial Hold after interruption", () => {
  const s = setup();
  s.services.b.priorityGroup = "interception";
  send(s, "a");
  m.acceptDisplay(s, s.generation, now);
  send(s, "low");
  send(s, "b", now + 2000);
  m.acceptDisplay(s, s.generation, now + 2000);
  m.finishItem(s, s.selected!, "resolved", 1, now + 4000);
  expect(active(s)).toBe("a");
  m.acceptDisplay(s, s.generation, now + 4000);
  m.tick(s, now + 6999);
  expect(active(s)).toBe("a");
  m.tick(s, now + 7000);
  expect(active(s)).toBe("low");
  m.acceptDisplay(s, s.generation, now + 7000);
  m.tick(s, now + 12000);
  expect(active(s)).toBe("a");
});

it("preserves a persisted active Hold and budget even if old computer ordering chose a later ticket", () => {
  let s = setup();
  send(s, "low");
  m.acceptDisplay(s, s.generation, now);
  send(s, "a");
  m.tick(s, now + 2000);
  // A pre-upgrade computer/service order could select a later global ticket.
  s.serviceTurns.low.ticket = ++s.turnSeq;
  const before = structuredClone(s.serviceTurns);
  const occurrence = s.selected;
  s = JSON.parse(JSON.stringify(s));
  m.tick(s, now + 2000);
  expect(s.selected).toBe(occurrence);
  expect(s.serviceTurns).toEqual(before);
  m.tick(s, now + 5000);
  expect(active(s)).toBe("a");
});
