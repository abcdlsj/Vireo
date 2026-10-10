import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseConfig, type CloudConfig } from "../core/config.js";

/** The Node server's settings: the shared ones plus where it listens and keeps data. */
export interface ServerConfig extends CloudConfig {
  port: number;
  host: string;
  dataDir: string;
  /** Serves the built app from this directory too, for a single-origin setup. */
  webDir?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.VIREO_CLOUD_PORT ?? env.PORT ?? 8700);
  const dataDir = resolve(env.VIREO_CLOUD_DATA_DIR ?? join(process.cwd(), "data", "cloud"));
  mkdirSync(dataDir, { recursive: true });
  return {
    ...parseConfig(env, `http://localhost:${port}`),
    port,
    host: env.VIREO_CLOUD_HOST ?? "0.0.0.0",
    dataDir,
    webDir: env.VIREO_WEB_DIR ? resolve(env.VIREO_WEB_DIR) : undefined,
  };
}
