import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { NodeMode } from "@vireo/protocol";

/**
 * Node configuration. A node is headless: it runs the agent and serves its
 * API to the Vireo app, reached through the cloud relay or directly over
 * Tailscale. Every value has a working default; environment variables (or
 * the command line, see cli.ts) only override them.
 */
export interface Config {
  port: number;
  /** Bind address. Loopback by default: the app reaches the node through the cloud or `tailscale serve`. */
  host: string;
  dataDir: string;
  /** The Vireo cloud this node signs in with and, in relay mode, connects to. */
  cloudUrl: string;
  /** Name suggested when linking; the owner can change it in the app. */
  name: string;
  /** How the app reaches this node. Applies when linking; saved with the node's identity. */
  mode: NodeMode;
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
  /** Public base URL for OAuth redirects and webhooks; the relay or tailnet address otherwise. */
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

/** The cloud a node uses unless told otherwise (VIREO_CLOUD_URL or --cloud). */
export const DEFAULT_CLOUD = "https://cloud.askvireo.com";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.VIREO_DATA_DIR ?? join(process.cwd(), "data"));
  mkdirSync(dataDir, { recursive: true });
  return {
    port: Number(env.VIREO_PORT ?? env.PORT ?? 8787),
    host: env.VIREO_HOST ?? "127.0.0.1",
    dataDir,
    cloudUrl: (env.VIREO_CLOUD_URL ?? DEFAULT_CLOUD).replace(/\/+$/, ""),
    name: env.VIREO_NAME?.trim() || hostname(),
    mode: env.VIREO_MODE === "tailscale" ? "tailscale" : "relay",
    fakeModel: bool(env.VIREO_FAKE_MODEL, false),
    fakeGoogle: bool(env.VIREO_FAKE_GOOGLE, false),
    searchEndpoint: env.VIREO_SEARCH_ENDPOINT || undefined,
    searxngUrl: env.VIREO_SEARXNG_URL || undefined,
    braveApiKey: env.BRAVE_API_KEY || undefined,
    schedulerIntervalMs: Number(env.VIREO_SCHEDULER_INTERVAL_MS ?? 30_000),
    publicUrl: env.VIREO_PUBLIC_URL?.replace(/\/$/, "") || undefined,
    chromiumPath: env.VIREO_CHROMIUM_PATH || undefined,
    browserHeadless: bool(env.VIREO_BROWSER_HEADLESS, true),
    testMode: bool(env.VIREO_TEST_MODE, false),
  };
}
