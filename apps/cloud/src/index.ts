import { loadConfig } from "./config.js";
import { runCloud } from "./server.js";

const config = loadConfig();
const running = await runCloud(config);
console.log(
  [
    "",
    `  Vireo cloud is running on http://localhost:${running.port}`,
    `  Public address: ${config.publicUrl}`,
    `  App: ${config.webUrl}${config.webDir ? " (served here too)" : ""}`,
    `  Sign-in: ${config.github ? "GitHub" : "GitHub is not configured (set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET)"}${config.devLogin ? ", plus development sign-in by name" : ""}`,
    "",
  ].join("\n"),
);

const shutdown = () => void running.stop().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
