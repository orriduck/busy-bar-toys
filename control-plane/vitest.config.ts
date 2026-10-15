import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TOKEN_ENCRYPTION_KEY:
            "0000000000000000000000000000000000000000000000000000000000000000",
          SESSION_SIGNING_KEY: "test-only-session-signing-key-long-enough",
          PUBLIC_ORIGIN: "https://control.test",
        },
      },
    }),
  ],
  test: { fileParallelism: false },
});
