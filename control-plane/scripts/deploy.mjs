import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { legacyDeployEnv } from "./deploy-env.ts";

if (
  process.env.WRANGLER_CI_OVERRIDE_NAME &&
  process.env.WRANGLER_CI_OVERRIDE_NAME !== "btc"
) {
  throw new Error("Native build target must be btc before migration deploy.");
}
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--dry-run"))
  throw new Error("Only --dry-run is supported.");
const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const cwd = fileURLToPath(new URL("..", import.meta.url));
function deploy(config, env) {
  const result = spawnSync(
    process.execPath,
    [wrangler, "deploy", "--config", config, ...args],
    { cwd, env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
// First deploy keeps Cloudflare's current Worker target protections intact.
deploy("wrangler.jsonc", process.env);
// Workers Builds otherwise forces this second config back onto btc.
deploy("wrangler.legacy.jsonc", legacyDeployEnv(process.env));
