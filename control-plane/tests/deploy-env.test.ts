import { describe, expect, it } from "vitest";
import { legacyDeployEnv } from "../scripts/deploy-env";
describe("compatibility deployment target isolation", () => {
  it("does not inherit the native BTC target override or match tag", () => {
    const original = {
      WRANGLER_CI_OVERRIDE_NAME: "btc",
      WRANGLER_CI_MATCH_TAG: "btc-worker-tag",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "test-only",
      NODE_VERSION: "26",
    };
    const result = legacyDeployEnv(original);
    expect(result).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "test-only",
      NODE_VERSION: "26",
    });
    expect(original.WRANGLER_CI_OVERRIDE_NAME).toBe("btc");
    expect(original.WRANGLER_CI_MATCH_TAG).toBe("btc-worker-tag");
  });
});
