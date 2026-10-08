import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type OAuthLoginCallbacks,
  completeSimple,
  registerFauxProvider,
  streamSimple,
} from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { AuthStorage, ModelRegistry, SettingsManager } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { errorMessage, newId, now } from "./util.js";
import { fakeResponse } from "./fake-model.js";

/**
 * Model access goes through pi's SDK. Credentials are read from the owner's
 * own pi agent directory (~/.pi/agent/auth.json), so whatever the owner is
 * logged in to with `pi` (Claude Pro/Max, ChatGPT/Codex, Copilot, API keys…)
 * works in Vireo with no extra configuration, using the owner's own quota.
 */

export interface ModelRef {
  provider: string;
  id: string;
  name: string;
}

export interface ModelChoice {
  /** "provider/modelId" overrides; empty means automatic. */
  main?: string;
  fast?: string;
}

export interface ModelStatus {
  ready: boolean;
  fake: boolean;
  main?: ModelRef;
  fast?: ModelRef;
  available: ModelRef[];
  piAgentDir: string;
  providers: { id: string; name: string; configured: boolean; source?: string; oauth: boolean }[];
  error?: string;
}

/** Preferred providers when nothing is configured, strongest-first. */
const PROVIDER_PREFERENCE = [
  "anthropic",
  "openai-codex",
  "openai",
  "google",
  "github-copilot",
  "amazon-bedrock",
  "google-vertex",
  "azure-openai-responses",
  "openrouter",
  "deepseek",
  "xai",
  "mistral",
];

const MAIN_PATTERNS = [/opus/, /sonnet/, /^gpt-5(\.\d+)?$/, /gpt-5/, /gemini-.*pro/, /./];
const FAST_PATTERN = /(haiku|mini|flash|nano|lite|small|fast)/i;

interface LoginSession {
  id: string;
  provider: string;
  status: "running" | "done" | "error";
  authUrl?: string;
  instructions?: string;
  progress: string[];
  prompt?: { kind: "text" | "select"; message: string; placeholder?: string; options?: { id: string; label: string }[] };
  answer?: (value: string | undefined) => void;
  error?: string;
}

export class ModelService {
  readonly authStorage: AuthStorage;
  readonly registry: ModelRegistry;
  private fakeRegistration?: ReturnType<typeof registerFauxProvider>;
  private logins = new Map<string, LoginSession>();

  constructor(
    private readonly config: Config,
    private readonly db: Db,
  ) {
    this.authStorage = AuthStorage.create(join(config.piAgentDir, "auth.json"));
    this.registry = ModelRegistry.create(this.authStorage, join(config.piAgentDir, "models.json"));
    if (config.fakeModel) this.setupFake();
  }

  private setupFake(): void {
    const reg = registerFauxProvider({
      provider: "vireo-fake",
      api: "vireo-fake",
      models: [
        { id: "fake-main", name: "Vireo scripted model", reasoning: false, input: ["text", "image"] },
        { id: "fake-fast", name: "Vireo scripted model (fast)", reasoning: false },
      ],
      tokensPerSecond: Number(process.env.VIREO_FAKE_TOKENS_PER_SECOND ?? 400),
    });
    const factory = (context: Context) => fakeResponse(context);
    const refill = () => {
      if (reg.getPendingResponseCount() < 100) reg.appendResponses(Array.from({ length: 1000 }, () => factory));
    };
    refill();
    setInterval(refill, 1000).unref();
    this.fakeRegistration = reg;
  }

  getChoice(): ModelChoice {
    return this.db.getKv<ModelChoice>("models.choice") ?? {};
  }

  setChoice(choice: ModelChoice): void {
    this.db.setKv("models.choice", choice);
  }

  available(): Model<Api>[] {
    if (this.fakeRegistration) return [...this.fakeRegistration.models];
    this.authStorage.reload();
    this.registry.refresh();
    return this.registry.getAvailable();
  }

  private findRef(ref: string | undefined, models: Model<Api>[]): Model<Api> | undefined {
    if (!ref) return undefined;
    const [provider, ...rest] = ref.split("/");
    const id = rest.join("/");
    return models.find((m) => m.provider === provider && m.id === id) ?? models.find((m) => m.id === ref);
  }

  /** The strongest configured model: owner choice, then pi's default, then a preference list. */
  mainModel(): Model<Api> | undefined {
    const models = this.available();
    if (models.length === 0) return undefined;
    if (this.fakeRegistration) return this.fakeRegistration.getModel("fake-main");
    const chosen = this.findRef(this.getChoice().main, models);
    if (chosen) return chosen;
    try {
      const settings = SettingsManager.create(process.cwd(), this.config.piAgentDir);
      const provider = settings.getDefaultProvider();
      const modelId = settings.getDefaultModel();
      if (provider && modelId) {
        const m = models.find((x) => x.provider === provider && x.id === modelId);
        if (m) return m;
      }
    } catch {
      // pi settings are optional
    }
    const providers = [...new Set(models.map((m) => m.provider))].sort((a, b) => rank(a) - rank(b));
    const provider = providers[0]!;
    const own = models.filter((m) => m.provider === provider && !FAST_PATTERN.test(m.id));
    const pool = own.length > 0 ? own : models.filter((m) => m.provider === provider);
    for (const pattern of MAIN_PATTERNS) {
      const hits = pool.filter((m) => pattern.test(m.id)).sort(newestFirst);
      if (hits.length > 0) return hits[0];
    }
    return pool[0];
  }

  /** A cheaper model for routine work (titles, memory upkeep, summaries). */
  fastModel(): Model<Api> | undefined {
    const models = this.available();
    if (this.fakeRegistration) return this.fakeRegistration.getModel("fake-fast");
    const chosen = this.findRef(this.getChoice().fast, models);
    if (chosen) return chosen;
    const main = this.mainModel();
    if (!main) return undefined;
    const sameProvider = models
      .filter((m) => m.provider === main.provider && FAST_PATTERN.test(m.id) && !/preview|image|audio|tts|realtime|embed/.test(m.id))
      .sort(newestFirst);
    return sameProvider[0] ?? main;
  }

  status(): ModelStatus {
    let error: string | undefined;
    let available: Model<Api>[] = [];
    try {
      available = this.available();
    } catch (err) {
      error = errorMessage(err);
    }
    const main = this.mainModel();
    const fast = this.fastModel();
    const oauthIds = new Set(this.authStorage.getOAuthProviders().map((p) => p.id));
    const providerIds = [...new Set([...PROVIDER_PREFERENCE, ...oauthIds])];
    return {
      ready: Boolean(main),
      fake: Boolean(this.fakeRegistration),
      main: main && ref(main),
      fast: fast && ref(fast),
      available: available.map(ref),
      piAgentDir: this.config.piAgentDir,
      providers: providerIds.map((id) => {
        const st = this.authStorage.getAuthStatus(id);
        return {
          id,
          name: this.registry.getProviderDisplayName(id),
          configured: st.configured,
          source: st.source,
          oauth: oauthIds.has(id),
        };
      }),
      error: error ?? this.registry.getError(),
    };
  }

  /** Stream function for pi-agent-core that resolves fresh credentials per request. */
  readonly streamFn: StreamFn = async (model, context, options) => {
    if (this.fakeRegistration) return streamSimple(model, context, options);
    const auth = await this.registry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    return streamSimple(model, context, {
      ...options,
      apiKey: auth.apiKey ?? options?.apiKey,
      headers: { ...(options?.headers ?? {}), ...(auth.headers ?? {}) },
    });
  };

  /**
   * One-shot completion for routine work. The first system line names the
   * task so logs and the scripted test model can tell calls apart.
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
    if (!model) throw new Error("No model is configured. Sign in to a model provider in Settings.");
    const started = now();
    let message: AssistantMessage;
    try {
      const auth = this.fakeRegistration ? { ok: true as const } : await this.registry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
      message = await completeSimple(
        model,
        {
          systemPrompt: `Task: ${opts.task}\n\n${opts.system}`,
          messages: [{ role: "user", content: opts.prompt, timestamp: now() }],
        },
        {
          apiKey: "apiKey" in auth ? auth.apiKey : undefined,
          headers: "headers" in auth ? auth.headers : undefined,
          maxTokens: opts.maxTokens ?? 2000,
        },
      );
    } catch (err) {
      this.recordUsage({ threadId: opts.threadId, purpose: opts.task, model, durationMs: now() - started, error: errorMessage(err) });
      throw err;
    }
    this.recordUsage({ threadId: opts.threadId, purpose: opts.task, model, message, durationMs: now() - started });
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? "Model call failed");
    }
    return message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  /** Like complete() but parses a JSON object out of the reply. */
  async completeJson<T>(opts: Parameters<ModelService["complete"]>[0]): Promise<T | undefined> {
    const text = await this.complete(opts);
    return extractJson<T>(text);
  }

  recordUsage(opts: {
    threadId?: string;
    purpose: string;
    agent?: string;
    model: Model<Api>;
    message?: AssistantMessage;
    durationMs?: number;
    error?: string;
  }): void {
    const u = opts.message?.usage;
    this.db.run(
      `INSERT INTO llm_calls (thread_id, purpose, agent, provider, model, input_tokens, output_tokens, cost, duration_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      opts.threadId ?? null,
      opts.purpose,
      opts.agent ?? null,
      opts.model.provider,
      opts.model.id,
      u ? u.input + u.cacheRead + u.cacheWrite : 0,
      u?.output ?? 0,
      u?.cost?.total ?? 0,
      opts.durationMs ?? null,
      opts.error ?? opts.message?.errorMessage ?? null,
      now(),
    );
  }

  // ---- Provider sign-in from the web app (uses pi's OAuth flows) ----

  oauthProviders(): { id: string; name: string }[] {
    return this.authStorage.getOAuthProviders().map((p) => ({ id: p.id, name: p.name }));
  }

  startLogin(provider: string): LoginSession {
    const session: LoginSession = { id: newId("login"), provider, status: "running", progress: [] };
    this.logins.set(session.id, session);
    const ask = (prompt: LoginSession["prompt"]) =>
      new Promise<string | undefined>((resolve) => {
        session.prompt = prompt;
        session.answer = (v) => {
          session.prompt = undefined;
          session.answer = undefined;
          resolve(v);
        };
      });
    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => {
        session.authUrl = info.url;
        session.instructions = info.instructions;
      },
      onPrompt: async (p) => (await ask({ kind: "text", message: p.message, placeholder: p.placeholder })) ?? "",
      onManualCodeInput: async () =>
        (await ask({
          kind: "text",
          message: "After approving, paste the final redirect URL or the code shown here.",
        })) ?? "",
      onSelect: async (p) => ask({ kind: "select", message: p.message, options: p.options }),
      onProgress: (m) => session.progress.push(m),
    };
    this.authStorage
      .login(provider, callbacks)
      .then(() => {
        session.status = "done";
      })
      .catch((err) => {
        session.status = "error";
        session.error = errorMessage(err);
      });
    return session;
  }

  getLogin(id: string): Omit<LoginSession, "answer"> | undefined {
    const s = this.logins.get(id);
    if (!s) return undefined;
    const { answer: _answer, ...rest } = s;
    return rest;
  }

  answerLogin(id: string, value: string | undefined): boolean {
    const s = this.logins.get(id);
    if (!s?.answer) return false;
    s.answer(value);
    return true;
  }

  setApiKey(provider: string, key: string): void {
    this.authStorage.set(provider, { type: "api_key", key });
  }

  logout(provider: string): void {
    this.authStorage.logout(provider);
  }
}

function rank(provider: string): number {
  const i = PROVIDER_PREFERENCE.indexOf(provider);
  return i === -1 ? PROVIDER_PREFERENCE.length : i;
}

function newestFirst(a: Model<Api>, b: Model<Api>): number {
  return b.id.localeCompare(a.id, undefined, { numeric: true });
}

function ref(m: Model<Api>): ModelRef {
  return { provider: m.provider, id: m.id, name: m.name };
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
