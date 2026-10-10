import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// In development the cloud runs alongside (npm run dev); everything the app
// asks of it goes through this server, so the app is same-origin with it.
const cloud = process.env.VIREO_CLOUD_URL ?? "http://localhost:8700";

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(["/api", "/auth", "/n", "/.well-known"].map((p) => [p, { target: cloud, changeOrigin: false }])),
  },
});
