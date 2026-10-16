import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Plugin } from "vite";
import { shellStrategy } from "./cache-policy.ts";

/** Build-pinned public shell only. No generic runtime cache or API interception. */
export function appShellWorker(): Plugin {
  let outDir = "";
  return {
    name: "btc-app-shell-worker",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const publicPaths = [
        "/index.html",
        "/theme-init.js",
        "/manifest.webmanifest",
        "/icons/icon-192.png",
        "/icons/icon-512.png",
        "/icons/apple-touch-icon.png",
        "/busy-traffic-control.png",
        "/busy-device-shell.webp",
        "/apps/chatgpt.png",
        "/apps/claude.png",
        "/apps/dots.svg",
      ];
      const generated = readdirSync(join(outDir, "assets"))
        .map((name) => "assets/" + name)
        .filter((path) => /\.(?:js|css|woff2)$/.test(path))
        .map((path) => "/" + path);
      const paths = [...new Set([...publicPaths, ...generated])].sort();
      const version = createHash("sha256").update(JSON.stringify(generated));
      for (const path of publicPaths)
        version.update(readFileSync(join(outDir, path)));
      const cache = "btc-shell-" + version.digest("hex").slice(0, 16);
      writeFileSync(
        join(outDir, "sw.js"),
        `
const CACHE = ${JSON.stringify(cache)};
const PATHS = ${JSON.stringify(paths)};
const strategy = ${shellStrategy.toString()};
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PATHS)));
  // Do not skipWaiting: existing drafts and live streams keep their current worker.
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith("btc-shell-") && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const kind = strategy(event.request, self.location.origin, PATHS);
  if (!kind) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (kind === "navigation") {
      try { return await fetch(event.request); }
      catch { return await cache.match("/index.html") || Response.error(); }
    }
    return await cache.match(new URL(event.request.url).pathname) || fetch(event.request);
  })());
});
`,
      );
    },
  };
}
