/** Serialized into the worker as well as exercised in runtime tests. No captures. */
export function shellStrategy(
  request: { url: string; method: string; mode: string },
  origin: string,
  publicPaths: readonly string[],
): "navigation" | "asset" | null {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== origin ||
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/")
  )
    return null;
  if (request.mode === "navigate") return "navigation";
  return publicPaths.includes(url.pathname) ? "asset" : null;
}
