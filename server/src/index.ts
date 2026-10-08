import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createHttp } from "./http.js";

const config = loadConfig();
const app = createApp(config);
const http = createHttp(app);

const server = serve({ fetch: http.fetch, port: config.port, hostname: config.host }, (info) => {
  const status = app.models.status();
  const lines = [
    "",
    `  Vireo is running on http://localhost:${info.port}`,
    `  Data: ${config.dataDir}`,
    status.ready
      ? `  Model: ${status.main?.provider}/${status.main?.id} (routine work: ${status.fast?.provider}/${status.fast?.id})`
      : `  Model: none yet. Sign in from Settings, or run \`pi\` and /login (credentials in ${config.piAgentDir}).`,
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
