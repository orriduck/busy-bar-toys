# Cloudflare deployment

The production Worker is `busy-bar-control-plane`. Cloudflare Workers Builds connects directly to `orriduck/busy-bar-toys`. Production follows `main` only. Preview branch builds are disabled. GitHub Actions continues to run tests and does not deploy.

| Setting | Value |
| --- | --- |
| Root directory | `control-plane` |
| Build command | `npm test && npm run typecheck && npm run build` |
| Deploy command | `npx wrangler deploy` |
| Build variable | `NODE_VERSION=26` |

The existing Cloudflare-managed build credential is selected in the dashboard. Do not copy it into source or GitHub secrets. Runtime secrets remain on the existing Worker. Keep the Worker name and Durable Object namespace unchanged. A failed build must stop deployment.

After merging, check the Cloudflare build for the exact main commit. Confirm that the deploy step succeeds, then verify the production page and its new asset hash. Worker assets and the existing device object can update at different times; inspect actual API fields before accepting a backend change.

Official reference: https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
