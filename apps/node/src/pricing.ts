import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { errorMessage } from "./util.js";

/**
 * Model prices and context windows from models.dev, cached in the data
 * directory and refreshed once a day. Prices are USD per million tokens.
 */

export interface ModelInfo {
  /** models.dev "provider/model" the name resolved to. */
  ref: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  context?: number;
}

export interface TokenCounts {
  /** Prompt tokens, cached ones included (OpenAI-style accounting). */
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

interface DevModel {
  id?: string;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number };
}
type DevCatalog = Record<string, { models?: Record<string, DevModel> }>;

const SOURCE = "https://models.dev/api.json";
const MAX_AGE = 24 * 3600_000;
/** Proxy prefixes (LiteLLM, OpenRouter) that differ from models.dev provider ids. */
const PROVIDER_ALIAS: Record<string, string> = { gemini: "google", vertex_ai: "google-vertex", bedrock: "amazon-bedrock", together_ai: "togetherai" };
/** Where a bare model name most likely comes from, checked before any reseller. */
const HOME_PROVIDERS = ["anthropic", "openai", "google", "deepseek", "mistral", "xai", "alibaba", "moonshotai", "zhipuai"];

export class Pricing {
  private catalog?: DevCatalog;
  private loading?: Promise<void>;
  private loadedAt = 0;
  private memo = new Map<string, ModelInfo | null>();
  private readonly file: string;

  constructor(private readonly config: Config) {
    this.file = join(config.dataDir, "models-dev.json");
    try {
      this.use(JSON.parse(readFileSync(this.file, "utf8")) as DevCatalog, statSync(this.file).mtimeMs);
    } catch {
      // No cached copy yet.
    }
    void this.refresh();
  }

  /** Fetches a fresh catalog when the cached one is missing or older than a day; offline under tests and the scripted model. Never throws. */
  refresh(): Promise<void> {
    if (this.config.testMode || this.config.fakeModel || Date.now() - this.loadedAt < MAX_AGE) return Promise.resolve();
    this.loading ??= (async () => {
      try {
        const res = await fetch(SOURCE, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        this.use(JSON.parse(text) as DevCatalog, Date.now());
        writeFileSync(this.file, text);
      } catch (err) {
        console.warn(`[pricing] could not load ${SOURCE}: ${errorMessage(err)}`);
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  private use(catalog: DevCatalog, at: number): void {
    this.catalog = catalog;
    this.loadedAt = at;
    this.memo.clear();
  }

  /** Price and context window for a model name as sent to the endpoint, e.g. "anthropic/claude-sonnet-4-5". */
  lookup(name: string): ModelInfo | undefined {
    void this.refresh();
    if (!this.catalog || !name) return undefined;
    if (!this.memo.has(name)) this.memo.set(name, this.resolve(name) ?? null);
    return this.memo.get(name) ?? undefined;
  }

  /** USD cost of a token count, or undefined when the model has no known price. */
  cost(name: string, t: TokenCounts): number | undefined {
    const p = this.lookup(name);
    if (p?.input === undefined || p.output === undefined) return undefined;
    const fresh = Math.max(0, t.input - t.cached - t.cacheWrite);
    return (fresh * p.input + t.cached * (p.cacheRead ?? p.input) + t.cacheWrite * (p.cacheWrite ?? p.input) + t.output * p.output) / 1e6;
  }

  private resolve(name: string): ModelInfo | undefined {
    const catalog = this.catalog!;
    const parts = name.split("/");
    const found = (provider: string, id: string): ModelInfo | undefined => {
      const m = catalog[provider]?.models?.[id];
      if (!m) return undefined;
      return { ref: `${provider}/${id}`, input: m.cost?.input, output: m.cost?.output, cacheRead: m.cost?.cache_read, cacheWrite: m.cost?.cache_write, context: m.limit?.context };
    };

    // "provider/model", including resellers whose own ids contain a slash ("openrouter/anthropic/claude-…").
    if (parts.length > 1) {
      const provider = PROVIDER_ALIAS[parts[0]!] ?? parts[0]!;
      const hit = found(provider, parts.slice(1).join("/"));
      if (hit) return hit;
    }

    // Bare or unmatched names: the model's home provider first, then anyone who lists it.
    const bare = parts.at(-1)!;
    const keys = [bare, normalize(bare)];
    const order = [...new Set([...parts.slice(0, -1).map((p) => PROVIDER_ALIAS[p] ?? p), ...HOME_PROVIDERS, ...Object.keys(catalog)])];
    for (const provider of order) {
      const models = catalog[provider]?.models;
      if (!models) continue;
      for (const key of keys) if (models[key]) return found(provider, key);
      const id = Object.keys(models).find((k) => normalize(k) === keys[1]);
      if (id) return found(provider, id);
    }
    return undefined;
  }
}

/** Loose comparison key: case, date suffixes and "." versus "-" in version numbers don't matter. */
function normalize(id: string): string {
  return id
    .toLowerCase()
    .replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, "")
    .replace(/(\d)\.(\d)/g, "$1-$2");
}
