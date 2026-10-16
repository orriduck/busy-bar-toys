/** Old collector endpoint after the data-owning Worker is renamed to btc. */
export interface LegacyEnv {
  BTC: Fetcher;
}
const canonicalOrigin = "https://btc.orriduck.workers.dev";
export default {
  async fetch(request: Request, env: LegacyEnv): Promise<Response> {
    const url = new URL(request.url);
    // Forward the original request/response, including WS upgrades and SSE streams.
    // Authentication, device binding, origin checks and limits remain in BTC.
    if (url.pathname.startsWith("/api/")) return env.BTC.fetch(request);
    const target = new URL(canonicalOrigin);
    target.pathname = url.pathname;
    target.search = url.search;
    return new Response(null, {
      status: 308,
      headers: { Location: target.href, "Cache-Control": "no-store" },
    });
  },
} satisfies ExportedHandler<LegacyEnv>;
