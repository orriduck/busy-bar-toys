import {
  PRIORITY_GROUPS,
  priorityGroupOf,
  type PriorityGroup,
} from "./priority-groups";
import { identifier, requireThat, type Computer, type State } from "./model";

/** One-time upgrade of declared legacy groups. These IDs are not hardware proof.
 * Publisher instance IDs and queue keys remain unchanged. Never infer groups for
 * newly registered services: their computer is an explicit management choice.
 */
export function migrateComputerIds(
  state: State,
  newId: () => string = () => crypto.randomUUID(),
) {
  const services = Object.values(state.services);
  if (services.every((s) => s.computerId)) return false;
  const parent = services.map((_, i) => i);
  const root = (i: number): number =>
    parent[i] === i ? i : (parent[i] = root(parent[i]));
  const seen = new Map<string, number>();
  services.forEach((service, i) => {
    const prefix = service.name.includes(" · ")
      ? service.name.split(" · ")[0].trim()
      : "";
    const sources = [
      ...(service.computerIds ?? []),
      ...Object.values(state.items)
        .filter((item) => item.serviceId === service.id)
        .map((item) => item.instanceId),
    ];
    const keys = [
      ...(prefix ? [`label:${prefix}`] : []),
      ...sources.map((id) => `source:${id}`),
    ];
    for (const key of keys) {
      const other = seen.get(key);
      if (other !== undefined) parent[root(i)] = root(other);
      seen.set(key, i);
    }
  });
  const ids = new Map<number, string>();
  // Preserve any already persisted identities in a partially upgraded state.
  services.forEach((s, i) => {
    if (s.computerId && !ids.has(root(i))) ids.set(root(i), s.computerId);
  });
  services.forEach((s, i) => {
    if (s.computerId) return;
    const group = root(i);
    if (!ids.has(group)) ids.set(group, newId());
    s.computerId = ids.get(group)!;
  });
  state.configRevision++;
  state.revision++;
  return true;
}

const CODE_LIFETIME = 300_000;
function has<T extends object>(value: T, key: string): key is keyof T & string {
  return Object.hasOwn(value, key);
}
function liveSession(s: State, id: string, now: number) {
  return has(s.sessions, id) && s.sessions[id] > now;
}
export function activeComputer(s: State, id: string): Computer {
  requireThat(
    has(s.computers, id) && !!s.computers[id].credentialHash,
    "COMPUTER_NOT_FOUND",
    404,
  );
  const computer = s.computers[id];
  requireThat(computer.revokedAt === undefined, "COMPUTER_REVOKED", 403);
  return computer;
}
export function sessionComputer(s: State, id: string, now = Date.now()) {
  const computerId = has(s.sessionComputers, id)
    ? s.sessionComputers[id]
    : null;
  return computerId &&
    liveSession(s, id, now) &&
    has(s.computers, computerId) &&
    !!s.computers[computerId].credentialHash &&
    s.computers[computerId].revokedAt === undefined
    ? computerId
    : null;
}
export function ownedService(s: State, computerId: string, serviceId: string) {
  activeComputer(s, computerId);
  requireThat(
    has(s.services, serviceId) &&
      s.services[serviceId].computerId === computerId,
    "SERVICE_NOT_OWNED",
    403,
  );
  return s.services[serviceId];
}
export function reorderOwnedServices(
  s: State,
  computerId: string,
  ids: unknown,
  expectedRevision: unknown,
) {
  const computer = activeComputer(s, computerId);
  requireThat(expectedRevision === s.configRevision, "CONFIG_CONFLICT", 409);
  const owned = Object.values(s.services).filter(
    (service) => service.computerId === computerId,
  );
  requireThat(
    Array.isArray(ids) &&
      ids.length === owned.length &&
      new Set(ids).size === owned.length &&
      ids.every(
        (id) =>
          typeof id === "string" &&
          has(s.services, id) &&
          s.services[id].computerId === computerId,
      ),
    "INVALID_SERVICE_ORDER",
  );
  computer.serviceOrder = [...ids];
  s.configRevision++;
  s.revision++;
}
/** Validate the entire transaction before changing any service or ordering. */
export function reorderOwnedGroups(
  s: State,
  computerId: string,
  groups: unknown,
  expectedRevision: unknown,
) {
  activeComputer(s, computerId);
  requireThat(expectedRevision === s.configRevision, "CONFIG_CONFLICT", 409);
  requireThat(
    groups !== null && typeof groups === "object" && !Array.isArray(groups),
    "INVALID_SERVICE_ORDER",
  );
  const mapping = groups as Record<PriorityGroup, unknown>;
  requireThat(
    Object.keys(mapping).length === PRIORITY_GROUPS.length &&
      PRIORITY_GROUPS.every(
        (group) =>
          Object.hasOwn(mapping, group) && Array.isArray(mapping[group]),
      ),
    "INVALID_SERVICE_ORDER",
  );
  const ids = PRIORITY_GROUPS.flatMap((group) => mapping[group] as unknown[]);
  const owned = Object.values(s.services).filter(
    (service) => service.computerId === computerId,
  );
  requireThat(
    ids.length === owned.length &&
      new Set(ids).size === owned.length &&
      ids.every(
        (id) =>
          typeof id === "string" &&
          has(s.services, id) &&
          s.services[id].computerId === computerId,
      ),
    "INVALID_SERVICE_ORDER",
  );
  let changed = false;
  for (const group of PRIORITY_GROUPS)
    for (const id of mapping[group] as string[])
      if (priorityGroupOf(s.services[id]) !== group) {
        s.services[id].priorityGroup = group;
        changed = true;
      }
  if (changed) {
    s.configRevision++;
    s.revision++;
  }
}
/** Remove expired control codes only after a successful operation's validation. */
export function expireComputerCodes(s: State, now: number) {
  for (const [hash, value] of Object.entries(s.enrollments))
    if (value.expiresAt <= now || !liveSession(s, value.sessionId, now))
      delete s.enrollments[hash];
  for (const [hash, value] of Object.entries(s.pairings))
    if (value.expiresAt <= now) delete s.pairings[hash];
  for (const id of Object.keys(s.sessionComputers))
    if (!liveSession(s, id, now)) delete s.sessionComputers[id];
}
export function beginEnrollment(
  s: State,
  sessionId: string,
  codeHash: string,
  computerId: string,
  now: number,
) {
  identifier(computerId);
  identifier(codeHash);
  requireThat(liveSession(s, sessionId, now), "UNAUTHORIZED", 401);
  requireThat(
    !sessionComputer(s, sessionId, now),
    "COMPUTER_ALREADY_BOUND",
    409,
  );
  requireThat(
    !has(s.computers, computerId) &&
      !Object.values(s.enrollments).some(
        (e) => e.computerId === computerId && e.expiresAt > now,
      ),
    "COMPUTER_EXISTS",
    409,
  );
  const pending = Object.values(s.enrollments).filter(
    (e) => e.expiresAt > now && liveSession(s, e.sessionId, now),
  );
  requireThat(
    !pending.some((e) => e.sessionId === sessionId),
    "ENROLLMENT_PENDING",
    409,
  );
  requireThat(pending.length < 16, "ENROLLMENT_CAPACITY", 413);
  requireThat(
    Object.keys(s.computers).length + pending.length < 32,
    "COMPUTER_CAPACITY",
    413,
  );
  requireThat(!has(s.enrollments, codeHash), "ENROLLMENT_INVALID", 409);
  expireComputerCodes(s, now);
  s.enrollments[codeHash] = {
    computerId,
    sessionId,
    expiresAt: now + CODE_LIFETIME,
  };
  s.revision++;
  return s.enrollments[codeHash];
}
export function redeemEnrollment(
  s: State,
  codeHash: string,
  credentialHash: string,
  now: number,
) {
  const enrollment = has(s.enrollments, codeHash)
    ? s.enrollments[codeHash]
    : null;
  requireThat(
    enrollment &&
      enrollment.expiresAt > now &&
      liveSession(s, enrollment.sessionId, now) &&
      !has(s.computers, enrollment.computerId),
    "ENROLLMENT_INVALID",
    403,
  );
  requireThat(
    !sessionComputer(s, enrollment.sessionId, now),
    "COMPUTER_ALREADY_BOUND",
    409,
  );
  requireThat(Object.keys(s.computers).length < 32, "COMPUTER_CAPACITY", 413);
  const computer: Computer = {
    id: enrollment.computerId,
    credentialHash,
    createdAt: now,
    serviceOrder: [],
  };
  s.computers[computer.id] = computer;
  s.sessionComputers[enrollment.sessionId] = computer.id;
  delete s.enrollments[codeHash];
  s.revision++;
  return computer;
}
export function issuePairing(
  s: State,
  computerId: string,
  codeHash: string,
  now: number,
) {
  activeComputer(s, computerId);
  identifier(codeHash);
  const pending = Object.values(s.pairings).filter((p) => p.expiresAt > now);
  requireThat(
    pending.length < 64 &&
      pending.filter((p) => p.computerId === computerId).length < 4,
    "PAIRING_CAPACITY",
    413,
  );
  requireThat(!has(s.pairings, codeHash), "PAIRING_INVALID", 409);
  expireComputerCodes(s, now);
  s.pairings[codeHash] = { computerId, expiresAt: now + CODE_LIFETIME };
  s.revision++;
  return s.pairings[codeHash];
}
export function redeemPairing(
  s: State,
  sessionId: string,
  codeHash: string,
  now: number,
) {
  const code = has(s.pairings, codeHash) ? s.pairings[codeHash] : null;
  requireThat(
    code &&
      code.expiresAt > now &&
      liveSession(s, sessionId, now) &&
      has(s.computers, code.computerId) &&
      s.computers[code.computerId].revokedAt === undefined,
    "PAIRING_INVALID",
    403,
  );
  const current = sessionComputer(s, sessionId, now);
  requireThat(
    !current || current === code.computerId,
    "COMPUTER_ALREADY_BOUND",
    409,
  );
  s.sessionComputers[sessionId] = code.computerId;
  delete s.pairings[codeHash];
  s.revision++;
  return code.computerId;
}
export function equalHash(a: string, b: string) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++)
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
/** Bootstrap once from the complete legacy installation, never a claimed ID. */
export function claimLegacy(
  s: State,
  publisherServiceId: string,
  proofs: Record<string, string>,
  credentialHash: string,
  now: number,
) {
  requireThat(
    has(s.services, publisherServiceId),
    "COMPUTER_PROOF_REQUIRED",
    403,
  );
  const computerId = s.services[publisherServiceId].computerId;
  requireThat(computerId, "COMPUTER_PROOF_REQUIRED", 403);
  requireThat(
    !s.computers[computerId]?.credentialHash,
    "COMPUTER_ALREADY_ENROLLED",
    409,
  );
  const pending = Object.values(s.enrollments).filter(
    (e) => e.expiresAt > now && liveSession(s, e.sessionId, now),
  );
  requireThat(
    Object.keys(s.computers).length + pending.length < 32 ||
      has(s.computers, computerId),
    "COMPUTER_CAPACITY",
    413,
  );
  const services = Object.values(s.services).filter(
    (service) => service.computerId === computerId,
  );
  requireThat(
    Object.keys(proofs).length === services.length &&
      services.every(
        (service) =>
          has(proofs, service.id) &&
          service.epochExpiresAt > now &&
          service.credentialHash.length > 0 &&
          equalHash(service.credentialHash, proofs[service.id]),
      ),
    "COMPUTER_PROOF_REQUIRED",
    403,
  );
  const computer: Computer = {
    id: computerId,
    credentialHash,
    createdAt: now,
    serviceOrder:
      s.computers[computerId]?.serviceOrder ??
      services
        .sort(
          (a, b) =>
            b.config.priority - a.config.priority || a.id.localeCompare(b.id),
        )
        .map((service) => service.id),
  };
  s.computers[computerId] = computer;
  s.revision++;
  return computer;
}
