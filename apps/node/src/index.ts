import { loadConfig } from "./config.js";
import { runNode } from "./server.js";

// Runs a node from environment variables (Docker, development, tests). People
// usually start one with `npx vireo-node` instead (cli.ts).

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

const node = await runNode(loadConfig());
const shutdown = () => void node.stop().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
