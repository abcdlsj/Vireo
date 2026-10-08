import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createHttp } from "./http.js";

if (process.env.VIREO_LOG_FILE) {
  // Mirror console output to a file (used by the test suite to inspect logs).
  const { appendFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const file = process.env.VIREO_LOG_FILE;
  mkdirSync(dirname(file), { recursive: true });
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      appendFileSync(file, `${args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack : JSON.stringify(a))).join(" ")}\n`);
    };
  }
}

const config = loadConfig();
const app = createApp(config);
const http = createHttp(app);

await app.models.refresh();
const server = serve({ fetch: http.fetch, port: config.port, hostname: config.host }, (info) => {
  const status = app.models.status();
  const lines = [
    "",
    `  Vireo is running on http://localhost:${info.port}`,
    `  Data: ${config.dataDir}`,
    status.ready
      ? `  Model: ${status.main} at ${status.baseUrl} (routine work: ${status.fast})`
      : `  Model: none yet. Set a base URL, API key and model in Settings, or set OPENAI_API_KEY.${status.error ? ` (${status.error})` : ""}`,
  ];
  if (!app.auth.hasOwner()) lines.push(`  First-run setup code: ${app.auth.setupCode} (not needed on localhost)`);
  console.log(lines.join("\n"), "\n");
  app.runner.resumeInterrupted();
  app.scheduler.start();
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.scheduler.stop();
  server.close();
  await Promise.race([app.runner.idle(), new Promise((r) => setTimeout(r, 5000))]);
  await app.browser.shutdown();
  app.db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
