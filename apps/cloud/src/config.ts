import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Cloud configuration; every value has a working default for local development. */
export interface CloudConfig {
  port: number;
  host: string;
  dataDir: string;
  /** Where this service is reached, e.g. https://cloud.vireo.dev. Used for OAuth redirects and relay addresses. */
  publicUrl: string;
  /** Where the app is served; sign-in returns there and link pages open there. */
  webUrl: string;
  /** Other app origins allowed to call this service (e.g. preview deployments). */
  extraOrigins: string[];
  /** Serves the built app from this directory too, for a single-origin setup. */
  webDir?: string;
  github?: { clientId: string; clientSecret: string };
  /** GitHub's endpoints, overridable for tests. */
  githubUrls: { authorize: string; token: string; api: string };
  /** Sign in by name without GitHub. Development and tests only. */
  devLogin: boolean;
  /** Lifetime of a node access token. */
  accessTtlMs: number;
}

function bool(v: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((v ?? "").toLowerCase());
}

const strip = (u: string) => u.replace(/\/+$/, "");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const port = Number(env.VIREO_CLOUD_PORT ?? env.PORT ?? 8700);
  const dataDir = resolve(env.VIREO_CLOUD_DATA_DIR ?? join(process.cwd(), "data", "cloud"));
  mkdirSync(dataDir, { recursive: true });
  const publicUrl = strip(env.VIREO_CLOUD_URL ?? `http://localhost:${port}`);
  const github = env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } : undefined;
  return {
    port,
    host: env.VIREO_CLOUD_HOST ?? "0.0.0.0",
    dataDir,
    publicUrl,
    webUrl: strip(env.VIREO_WEB_URL ?? publicUrl),
    extraOrigins: (env.VIREO_WEB_ORIGINS ?? "").split(",").map((o) => strip(o.trim())).filter(Boolean),
    webDir: env.VIREO_WEB_DIR ? resolve(env.VIREO_WEB_DIR) : undefined,
    github,
    githubUrls: {
      authorize: env.VIREO_GITHUB_AUTHORIZE_URL ?? "https://github.com/login/oauth/authorize",
      token: env.VIREO_GITHUB_TOKEN_URL ?? "https://github.com/login/oauth/access_token",
      api: env.VIREO_GITHUB_API_URL ?? "https://api.github.com",
    },
    devLogin: bool(env.VIREO_DEV_LOGIN),
    accessTtlMs: Number(env.VIREO_ACCESS_TTL_MS ?? 15 * 60_000),
  };
}
