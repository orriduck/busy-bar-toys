# BTC deployment

The public control plane is [BTC](https://btc.orriduck.workers.dev). The data-owning Worker is `btc`. Cloudflare Workers Builds connects directly to `orriduck/busy-bar-toys`; production follows `main`, preview builds are disabled, and GitHub Actions only tests.

| Setting | Value |
| --- | --- |
| Root directory | `control-plane` |
| Build command | `npm test && npm run typecheck && npm run build` |
| Deploy command | `npm run deploy` |
| Build variable | `NODE_VERSION=26` |

`npm run deploy` updates BTC first, then the old-host compatibility Worker. The primary child retains Cloudflare’s native build target guards. The legacy child removes only `WRANGLER_CI_OVERRIDE_NAME` and `WRANGLER_CI_MATCH_TAG`; otherwise the native target override could deploy the compatibility script onto BTC. Authentication and account variables are preserved. The existing Cloudflare build credential stays in Cloudflare. Runtime secrets stay on the data-owning Worker. Do not copy keys into source or GitHub secrets.

## Name migration

Rename the existing Worker in Cloudflare Settings from `busy-bar-control-plane` to `btc`; do not create a fresh database or deploy `wrangler.jsonc` as a new Worker before that rename. Record the Durable Object namespace ID before and after, and confirm it is unchanged. Change `PUBLIC_ORIGIN` to the new HTTPS origin, keep the two runtime secrets, and retain the existing Git integration. Update its deploy command to `npm run deploy`.

After the rename, deploy `wrangler.legacy.jsonc` at the former name. This stateless compatibility Worker forwards API requests, including publisher WebSockets and SSE, through a service binding to BTC. It preserves request/auth/origin/body and streamed responses. It redirects browser pages to a fixed BTC origin. The backend still enforces its existing auth, device and origin rules. Existing collectors can keep their configured old URL; new installations should use BTC.

Verify the original namespace and service IDs after migration. A new browser origin requires sign-in again; browser-local appearance and This computer preferences do not automatically migrate. Do not transfer session cookies between origins.

## Verify each release

Check the native Cloudflare build for the exact merge commit and main CI. Confirm deploy succeeds, then compare the production HTML/JS/CSS and `sw.js` with the tested build. Confirm `/api/mode` is not demo, unauthorized API calls remain unauthorized, and old collector endpoints still reach the same backend. Worker assets and an existing device object can update at different times; inspect actual fields and service identities for backend changes.

BTC is installable through the browser menu. On iOS, open BTC in Safari, choose Share → Add to Home Screen, and keep Open as Web App enabled if shown. The offline shell contains only public build assets; API data, credentials, queue and preview are never cached by the service worker. Existing open tabs retain their worker until closed; close and reopen the app to activate a waiting shell update.

Official references, checked 2026-10-16:

- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/
- https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable
