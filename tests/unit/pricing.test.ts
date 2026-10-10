import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/node/src/config.js";
import { cacheTokens } from "../../apps/node/src/models.js";
import { Pricing } from "../../apps/node/src/pricing.js";
import { tempDir, testApp } from "./helpers.js";

const CATALOG = {
  anthropic: {
    models: {
      "claude-sonnet-4-5-20250929": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }, limit: { context: 200000 } },
    },
  },
  openai: { models: { "gpt-5": { cost: { input: 1.25, output: 10, cache_read: 0.125 }, limit: { context: 400000 } } } },
  google: { models: { "gemini-2.5-flash": { cost: { input: 0.3, output: 2.5 }, limit: { context: 1048576 } } } },
  openrouter: { models: { "openai/gpt-5": { cost: { input: 2, output: 20 }, limit: { context: 400000 } } } },
};

function pricing(dir = tempDir()): Pricing {
  writeFileSync(join(dir, "models-dev.json"), JSON.stringify(CATALOG));
  return new Pricing(loadConfig({ VIREO_DATA_DIR: dir, VIREO_TEST_MODE: "1" }));
}

describe("models.dev pricing", () => {
  it("resolves proxy-style, bare and loosely written model names", () => {
    const p = pricing();
    expect(p.lookup("openai/gpt-5")?.ref).toBe("openai/gpt-5");
    expect(p.lookup("gpt-5")?.ref).toBe("openai/gpt-5");
    expect(p.lookup("gemini/gemini-2.5-flash")?.ref).toBe("google/gemini-2.5-flash");
    expect(p.lookup("openrouter/openai/gpt-5")?.ref).toBe("openrouter/openai/gpt-5");
    expect(p.lookup("anthropic/claude-sonnet-4.5")?.ref).toBe("anthropic/claude-sonnet-4-5-20250929");
    expect(p.lookup("anthropic/claude-sonnet-4-5")?.context).toBe(200000);
    expect(p.lookup("scripted-model")).toBeUndefined();
  });

  it("prices fresh input, cache reads, cache writes and output separately", () => {
    const p = pricing();
    const cost = p.cost("anthropic/claude-sonnet-4-5", { input: 1_000_000, cached: 600_000, cacheWrite: 100_000, output: 100_000 });
    // 0.3M fresh × $3 + 0.6M read × $0.3 + 0.1M write × $3.75 + 0.1M out × $15
    expect(cost).toBeCloseTo(0.9 + 0.18 + 0.375 + 1.5, 6);
    expect(p.cost("scripted-model", { input: 10, cached: 0, cacheWrite: 0, output: 10 })).toBeUndefined();
  });

  it("reads cache counts from usage details", () => {
    expect(cacheTokens({ cached_tokens: 40 })).toEqual({ cached: 40, cacheWrite: 0 });
    expect(cacheTokens([{ cached_tokens: 5, cache_creation_input_tokens: 7 }, { cached_tokens: 1 }])).toEqual({ cached: 6, cacheWrite: 7 });
    expect(cacheTokens(undefined)).toEqual({ cached: 0, cacheWrite: 0 });
  });

  it("stores cache counts with each model call", () => {
    const app = testApp();
    app.models.recordUsage({ threadId: undefined, purpose: "agent", model: "m", input: 100, output: 5, cached: 80, cacheWrite: 10 });
    const row = app.db.get<{ cached_tokens: number; cache_write_tokens: number }>("SELECT cached_tokens, cache_write_tokens FROM llm_calls ORDER BY id DESC LIMIT 1");
    expect(row).toEqual({ cached_tokens: 80, cache_write_tokens: 10 });
  });
});
