import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Runtime configuration. Every value has a working default so Vireo starts
 * without any configuration; environment variables only override defaults.
 */
export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** Directory holding pi's auth.json / models.json / settings.json. */
  piAgentDir: string;
  /** Directory with the built web app. */
  webDir: string;
  /** Use the deterministic scripted model instead of a real one (tests, demos). */
  fakeModel: boolean;
  /** Use in-memory Google Calendar / Gmail (tests, demos). */
  fakeGoogle: boolean;
  /** Override for the web search endpoint (tests point this at a fixture server). */
  searchEndpoint?: string;
  /** Optional SearXNG instance used for web search. */
  searxngUrl?: string;
  /** Optional Brave Search API key. */
  braveApiKey?: string;
  /** Interval for the background scheduler loop. */
  schedulerIntervalMs: number;
  /** Optional fixed owner password (skips the first-run setup screen). */
  ownerPassword?: string;
  /** Public base URL, used for OAuth redirect URIs. Detected from requests when unset. */
  publicUrl?: string;
  /** Path to a Chromium executable for browser actions. */
  chromiumPath?: string;
  /** Run the browser headless (default true). */
  browserHeadless: boolean;
  /** Enables test-only endpoints. Never set in production. */
  testMode: boolean;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.VIREO_DATA_DIR ?? join(process.cwd(), "data"));
  mkdirSync(dataDir, { recursive: true });
  const piAgentDir = resolve(
    env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  );
  // pi's SDK reads this variable; keep it consistent with what Vireo uses.
  process.env.PI_CODING_AGENT_DIR = piAgentDir;
  return {
    port: Number(env.VIREO_PORT ?? env.PORT ?? 8787),
    host: env.VIREO_HOST ?? "0.0.0.0",
    dataDir,
    piAgentDir,
    webDir: resolve(env.VIREO_WEB_DIR ?? join(process.cwd(), "dist", "web")),
    fakeModel: bool(env.VIREO_FAKE_MODEL, false),
    fakeGoogle: bool(env.VIREO_FAKE_GOOGLE, false),
    searchEndpoint: env.VIREO_SEARCH_ENDPOINT || undefined,
    searxngUrl: env.VIREO_SEARXNG_URL || undefined,
    braveApiKey: env.BRAVE_API_KEY || undefined,
    schedulerIntervalMs: Number(env.VIREO_SCHEDULER_INTERVAL_MS ?? 30_000),
    ownerPassword: env.VIREO_PASSWORD || undefined,
    publicUrl: env.VIREO_PUBLIC_URL?.replace(/\/$/, "") || undefined,
    chromiumPath: env.VIREO_CHROMIUM_PATH || undefined,
    browserHeadless: bool(env.VIREO_BROWSER_HEADLESS, true),
    testMode: bool(env.VIREO_TEST_MODE, false),
  };
}
