import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Writes app-config.json into the build. A static deployment (Vercel,
 * Cloudflare) has no host behind its own /api, so the app only uses paired
 * hosts; VITE_VIREO_HOST names one to offer by default. serve.mjs answers
 * this path itself, so self-hosted apps keep their local host.
 */
function appConfig(defaultHost: string | undefined): Plugin {
  return {
    name: "vireo-app-config",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "app-config.json",
        source: JSON.stringify({ localHost: false, defaultHost: defaultHost?.replace(/\/+$/, "") || undefined }),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "VITE_");
  return {
    root,
    plugins: [react(), appConfig(env.VITE_VIREO_HOST)],
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      proxy: { "/api": { target: process.env.VIREO_HOST_URL ?? "http://localhost:8787", changeOrigin: false } },
    },
  };
});
