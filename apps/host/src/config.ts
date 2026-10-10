import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Host configuration. The host is headless: it runs the agent and serves the
 * API; the Vireo app (web/) is the UI and can talk to several hosts.
 *
 * Runtime configuration. Every value has a working default so Vireo starts
 * without any configuration; environment variables only override defaults.
 */
export interface Config {
  port: number;
  host: string;
  dataDir: string;
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
  /** Name paired devices show for this host. Defaults to the machine's hostname. */
  hostName?: string;
  /** Where the Vireo app is served (e.g. on Vercel), so pairing links open it directly. */
  appUrl?: string;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.VIREO_DATA_DIR ?? join(process.cwd(), "data"));
  mkdirSync(dataDir, { recursive: true });
  return {
    port: Number(env.VIREO_PORT ?? env.PORT ?? 8787),
    host: env.VIREO_HOST ?? "0.0.0.0",
    dataDir,
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
    hostName: env.VIREO_NAME?.trim() || undefined,
    appUrl: env.VIREO_APP_URL?.replace(/\/$/, "") || undefined,
  };
}
