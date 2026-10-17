import { requireThat } from "./model";
/** Fixed browser lifetime; logout still revokes the server-side session. */
export const BROWSER_SESSION_SECONDS = 30 * 24 * 60 * 60;
const enc = new TextEncoder();
export function base64(bytes: Uint8Array) {
  let str = "";
  for (const byte of bytes) str += String.fromCharCode(byte);
  return btoa(str);
}
export function unbase64(s: string) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
export async function digest(value: string | Uint8Array) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof value === "string" ? enc.encode(value) : Uint8Array.from(value),
      ),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
async function aes(key: string) {
  requireThat(/^[a-fA-F0-9]{64}$/.test(key), "ENCRYPTION_NOT_CONFIGURED", 503);
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(key.match(/../g)!, (v) => parseInt(v, 16)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function encrypt(value: string, key: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aes(key),
    enc.encode(value),
  );
  return base64(iv) + "." + base64(new Uint8Array(ciphertext));
}
export async function decrypt(value: string, key: string) {
  const [iv, data] = value.split(".");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unbase64(iv) },
      await aes(key),
      unbase64(data),
    ),
  );
}
export interface Session {
  deviceId: string;
  id: string;
  expiresAt: number;
}
async function hmac(key: string) {
  requireThat(
    typeof key === "string" && key.length > 0,
    "SIGNING_NOT_CONFIGURED",
    503,
  );
  return crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signSession(session: Session, key: string) {
  const payload = base64(enc.encode(JSON.stringify(session)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmac(key),
    enc.encode(payload),
  );
  return payload + "." + base64(new Uint8Array(signature));
}
export async function verifySession(
  value: string,
  key: string,
  now: number,
): Promise<Session | null> {
  try {
    const [payload, signature, ...rest] = value.split(".");
    if (rest.length || !payload || !signature) return null;
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await hmac(key),
        unbase64(signature),
        enc.encode(payload),
      ))
    )
      return null;
    const session = JSON.parse(
      new TextDecoder().decode(unbase64(payload)),
    ) as Session;
    if (
      !/^[a-f0-9]{64}$/.test(session.deviceId) ||
      typeof session.id !== "string" ||
      !Number.isSafeInteger(session.expiresAt) ||
      session.expiresAt <= now
    )
      return null;
    return session;
  } catch {
    return null;
  }
}
export async function boundedBody(request: Request | Response, max: number) {
  const length = Number(request.headers.get("Content-Length"));
  requireThat(!Number.isFinite(length) || length <= max, "BODY_TOO_LARGE", 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) {
        await reader.cancel();
        requireThat(false, "BODY_TOO_LARGE", 413);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
export async function jsonBody(
  request: Request,
  max = 131072,
): Promise<Record<string, unknown>> {
  requireThat(
    request.headers.get("Content-Type")?.split(";")[0] === "application/json",
    "JSON_REQUIRED",
    415,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder().decode(await boundedBody(request, max)),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "BODY_TOO_LARGE")
      throw error;
    requireThat(false, "INVALID_JSON");
  }
  requireThat(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
  );
  return parsed as Record<string, unknown>;
}
