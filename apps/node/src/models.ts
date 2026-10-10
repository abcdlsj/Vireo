import { Agent, Runner, setTracingDisabled, type ModelProvider } from "@openai/agents";
import { OpenAIProvider } from "@openai/agents-openai";
import OpenAI from "openai";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { startFakeLlmServer } from "./fake-llm-server.js";
import { errorMessage, now } from "./util.js";
import type { LlmCall, UsageLog } from "./usage.js";
import type { Vault } from "./vault.js";
import type { LlmApi, ModelStatus } from "@vireo/protocol";

/**
 * Model access goes through the OpenAI Agents SDK, pointed at any
 * OpenAI-compatible endpoint: OpenAI itself, a LiteLLM proxy (which fronts
 * Anthropic, Gemini, Bedrock, Ollama and more), OpenRouter, a local server…
 * A base URL and an API key are all it needs.
 */


export interface LlmSettings {
  baseUrl?: string;
  apiKey?: string;
  /** Main model, for conversations and agent work. */
  model?: string;
  /** Cheaper model for routine work (titles, memory upkeep, summaries). */
  fastModel?: string;
  /** "chat" (Chat Completions, works everywhere) or "responses" (OpenAI's Responses API). */
  api?: LlmApi;
}


const OPENAI_URL = "https://api.openai.com/v1";
const NOT_CHAT = /(embed|tts|whisper|dall-e|image|audio|realtime|moderation|transcribe|search|vision-preview|davinci|babbage|rerank)/i;
const MAIN_PATTERNS = [/claude.*opus/i, /claude.*sonnet/i, /^(openai\/)?gpt-5(\.\d+)?$/i, /gpt-5(?!.*(mini|nano))/i, /gemini.*pro/i, /gpt-4\.1$/i, /gpt-4o$/i, /deepseek/i, /qwen/i, /./];
const FAST_PATTERN = /(haiku|mini|flash|nano|lite|small|fast)/i;

setTracingDisabled(true);

export class ModelService {
  private fakeUrl?: Promise<string>;
  private available: string[] = [];
  private listError?: string;
  private listedFor = "";
  private cached?: { key: string; provider: ModelProvider; client: OpenAI };

  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly usage: UsageLog,
  ) {
    if (config.fakeModel) this.fakeUrl = startFakeLlmServer().then((s) => s.url);
    void this.refresh();
  }

  // ---- configuration ----

  private saved(): LlmSettings {
    const s = this.db.getKv<LlmSettings & { apiKeyEnc?: string }>("llm.settings") ?? {};
    let apiKey: string | undefined;
    if (s.apiKeyEnc) {
      try {
        apiKey = this.vault.decrypt(s.apiKeyEnc);
      } catch {
        apiKey = undefined;
      }
    }
    return { baseUrl: s.baseUrl, model: s.model, fastModel: s.fastModel, api: s.api, apiKey };
  }

  /** Saves owner settings. Empty strings clear a value; an omitted apiKey keeps the stored one. */
  async save(input: LlmSettings): Promise<ModelStatus> {
    const cur = this.db.getKv<LlmSettings & { apiKeyEnc?: string }>("llm.settings") ?? {};
    const clean = (v: string | undefined, old: string | undefined) => (v === undefined ? old : v.trim() || undefined);
    const next = {
      baseUrl: clean(input.baseUrl, cur.baseUrl),
      model: clean(input.model, cur.model),
      fastModel: clean(input.fastModel, cur.fastModel),
      api: input.api ?? cur.api,
      apiKeyEnc: input.apiKey === undefined ? cur.apiKeyEnc : input.apiKey.trim() ? this.vault.encrypt(input.apiKey.trim()) : undefined,
    };
    this.db.setKv("llm.settings", next);
    this.cached = undefined;
    await this.refresh(true);
    return this.status();
  }

  /** Effective settings: what the owner saved in the app wins over environment variables. */
  private effective(): Required<Pick<LlmSettings, "baseUrl" | "api">> & LlmSettings & { source: ModelStatus["source"] } {
    const env = process.env;
    const s = this.saved();
    const envUrl = env.VIREO_LLM_BASE_URL || env.OPENAI_BASE_URL;
    const envKey = env.VIREO_LLM_API_KEY || env.OPENAI_API_KEY;
    const baseUrl = s.baseUrl || envUrl || OPENAI_URL;
    return {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey: s.apiKey || envKey,
      model: s.model || env.VIREO_MODEL || undefined,
      fastModel: s.fastModel || env.VIREO_FAST_MODEL || undefined,
      api: s.api || (env.VIREO_LLM_API === "responses" ? "responses" : "chat"),
      source: {
        baseUrl: s.baseUrl ? "settings" : envUrl ? "env" : "default",
        apiKey: s.apiKey ? "settings" : envKey ? "env" : "none",
      },
    };
  }

  /** The endpoint is usable: an API key, or a self-hosted endpoint that may not need one. */
  private reachable(): boolean {
    if (this.config.fakeModel) return true;
    const e = this.effective();
    return Boolean(e.apiKey) || e.source.baseUrl !== "default";
  }

  private async connection(): Promise<{ baseUrl: string; apiKey: string; api: LlmApi }> {
    if (this.fakeUrl) return { baseUrl: await this.fakeUrl, apiKey: "vireo-fake", api: "chat" };
    const e = this.effective();
    // Local endpoints such as Ollama accept any key, but the client requires one.
    return { baseUrl: e.baseUrl, apiKey: e.apiKey || "not-needed", api: e.api };
  }

  private async clients(): Promise<{ provider: ModelProvider; client: OpenAI }> {
    const c = await this.connection();
    const key = `${c.baseUrl}|${c.apiKey}|${c.api}`;
    if (this.cached?.key !== key) {
      const client = new OpenAI({ apiKey: c.apiKey, baseURL: c.baseUrl, timeout: 180_000, maxRetries: 2 });
      this.cached = { key, client, provider: new OpenAIProvider({ openAIClient: client, useResponses: c.api === "responses" }) };
    }
    return this.cached;
  }

  /** Lists the endpoint's models so the owner can pick, and so a model can be chosen automatically. */
  async refresh(force = false): Promise<void> {
    if (!this.reachable()) {
      this.available = [];
      this.listError = undefined;
      return;
    }
    const c = await this.connection();
    const key = `${c.baseUrl}|${c.apiKey}`;
    if (!force && key === this.listedFor && this.available.length) return;
    try {
      const { client } = await this.clients();
      const ids: string[] = [];
      for await (const m of client.models.list()) ids.push(m.id);
      this.available = ids.filter((id) => !NOT_CHAT.test(id) && !id.includes("*")).sort();
      this.listError = undefined;
    } catch (err) {
      this.available = [];
      this.listError = `Could not list models at ${c.baseUrl}: ${errorMessage(err)}`;
    }
    this.listedFor = key;
  }

  /** The main model name, or undefined when none is configured or discoverable. */
  mainModel(): string | undefined {
    if (!this.reachable()) return undefined;
    if (this.config.fakeModel) return this.saved().model || "fake-main";
    const e = this.effective();
    if (e.model) return e.model;
    for (const p of MAIN_PATTERNS) {
      const pool = this.available.filter((id) => !FAST_PATTERN.test(id) || p.source === ".");
      const hit = pool.filter((id) => p.test(id)).sort(newestFirst)[0];
      if (hit) return hit;
    }
    return undefined;
  }

  fastModel(): string | undefined {
    const main = this.mainModel();
    if (!main) return undefined;
    if (this.config.fakeModel) return this.saved().fastModel || "fake-fast";
    const e = this.effective();
    if (e.fastModel) return e.fastModel;
    // A cheaper sibling from the same family/provider, e.g. claude-*-haiku next to claude-*-sonnet.
    const family = main.split(/[-/:]/)[0]!;
    const sibling = this.available.filter((id) => id.startsWith(family) && FAST_PATTERN.test(id)).sort(newestFirst)[0];
    return sibling ?? main;
  }

  status(): ModelStatus {
    const e = this.effective();
    const s = this.saved();
    const main = this.mainModel();
    return {
      ready: Boolean(main),
      fake: this.config.fakeModel,
      baseUrl: this.config.fakeModel ? "(scripted model)" : e.baseUrl,
      hasKey: Boolean(e.apiKey),
      source: e.source,
      api: e.api,
      main,
      fast: this.fastModel(),
      choice: { main: s.model, fast: s.fastModel },
      available: this.available,
      error: this.listError ?? (this.reachable() && !main ? "No model selected. Choose one below, or set VIREO_MODEL." : undefined),
    };
  }

  /** The SDK runner for agent runs, bound to the current endpoint. */
  async runner(): Promise<Runner> {
    const { provider } = await this.clients();
    return new Runner({ modelProvider: provider, tracingDisabled: true });
  }

  /** Short name of the endpoint for usage records ("api.openai.com", "litellm", "scripted"). */
  providerLabel(): string {
    if (this.config.fakeModel) return "scripted";
    try {
      return new URL(this.effective().baseUrl).hostname;
    } catch {
      return "custom";
    }
  }

  /** Checks the endpoint and model with a tiny request. */
  async test(): Promise<{ ok: boolean; message: string }> {
    await this.refresh(true);
    try {
      const out = await this.complete({ task: "connection_test", system: "Reply with the single word: ok", prompt: "ping", maxTokens: 20, tier: "main" });
      return { ok: true, message: `Connected. ${this.mainModel()} replied: ${out.slice(0, 40)}` };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  /**
   * One-shot completion for routine work, run as a single-turn agent. The first
   * system line names the task so logs and the scripted test model can tell
   * calls apart.
   */
  async complete(opts: {
    task: string;
    system: string;
    prompt: string;
    threadId?: string;
    tier?: "fast" | "main";
    maxTokens?: number;
  }): Promise<string> {
    const model = opts.tier === "main" ? this.mainModel() : this.fastModel();
    if (!model) throw new Error("No model is configured. Set a base URL, API key and model in Settings.");
    const started = now();
    const agent = new Agent({
      name: opts.task,
      instructions: `Task: ${opts.task}\n\n${opts.system}`,
      model,
      modelSettings: { maxTokens: opts.maxTokens ?? 2000 },
    });
    try {
      const result = await (await this.runner()).run(agent, opts.prompt, { maxTurns: 1 });
      const u = result.state.usage;
      this.recordUsage({ threadId: opts.threadId, purpose: opts.task, model, input: u.inputTokens, output: u.outputTokens, ...cacheTokens(u.inputTokensDetails), durationMs: now() - started });
      return String(result.finalOutput ?? "").trim();
    } catch (err) {
      this.recordUsage({ threadId: opts.threadId, purpose: opts.task, model, durationMs: now() - started, error: errorMessage(err) });
      throw err;
    }
  }

  /** Like complete() but parses a JSON object out of the reply. */
  async completeJson<T>(opts: Parameters<ModelService["complete"]>[0]): Promise<T | undefined> {
    const text = await this.complete(opts);
    return extractJson<T>(text);
  }

  recordUsage(call: Omit<LlmCall, "provider">): void {
    this.usage.record({ ...call, provider: this.providerLabel() });
  }
}

/**
 * Cache read/write counts from a usage record's input details. Read is
 * "cached_tokens" everywhere; write has no standard name, so the spellings
 * LiteLLM and providers use are all accepted.
 */
export function cacheTokens(details: Record<string, number> | Array<Record<string, number>> | undefined): { cached: number; cacheWrite: number } {
  const list = Array.isArray(details) ? details : details ? [details] : [];
  let cached = 0;
  let cacheWrite = 0;
  for (const d of list) {
    cached += Number(d.cached_tokens ?? 0) || 0;
    cacheWrite += Number(d.cache_creation_tokens ?? d.cache_creation_input_tokens ?? d.cache_write_tokens ?? 0) || 0;
  }
  return { cached, cacheWrite };
}

function newestFirst(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true });
}

export function extractJson<T>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return undefined;
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(close);
  if (end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}
