import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  root: "ui",
  publicDir: "../public",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": new URL("./ui", import.meta.url).pathname } },
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
