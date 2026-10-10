import type { LlmCallRecord, ThreadUsage, UsageByPurpose } from "@vireo/protocol";
import type { Db } from "./db.js";
import type { Pricing } from "./pricing.js";
import { now } from "./util.js";

export interface LlmCall {
  threadId?: string;
  purpose: string;
  agent?: string;
  provider: string;
  model: string;
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
  durationMs?: number;
  error?: string;
}

interface Row {
  id: number;
  thread_id: string | null;
  purpose: string;
  agent: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
}

/** Every model call, with token counts; costs are priced when read, from current prices (N7). */
export class UsageLog {
  constructor(
    private readonly db: Db,
    private readonly pricing: Pricing,
  ) {}

  record(c: LlmCall): void {
    this.db.run(
      `INSERT INTO llm_calls (thread_id, purpose, agent, provider, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, cost, duration_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      c.threadId ?? null,
      c.purpose,
      c.agent ?? null,
      c.provider,
      c.model,
      c.input ?? 0,
      c.output ?? 0,
      c.cached ?? 0,
      c.cacheWrite ?? 0,
      c.durationMs ?? null,
      c.error ?? null,
      now(),
    );
  }

  private cost(model: string | null, t: { input: number; cached: number; cacheWrite: number; output: number }): number | null {
    return model ? (this.pricing.cost(model, t) ?? null) : null;
  }

  private toRecord(r: Row): LlmCallRecord {
    return {
      id: r.id,
      threadId: r.thread_id,
      purpose: r.purpose,
      agent: r.agent,
      provider: r.provider,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cachedTokens: r.cached_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      cost: this.cost(r.model, { input: r.input_tokens, cached: r.cached_tokens, cacheWrite: r.cache_write_tokens, output: r.output_tokens }),
      durationMs: r.duration_ms,
      error: r.error,
      createdAt: r.created_at,
    };
  }

  forThread(threadId: string): LlmCallRecord[] {
    return this.db.all<Row>("SELECT * FROM llm_calls WHERE thread_id = ? ORDER BY id", threadId).map((r) => this.toRecord(r));
  }

  all(): LlmCallRecord[] {
    return this.db.all<Row>("SELECT * FROM llm_calls ORDER BY id").map((r) => this.toRecord(r));
  }

  /** Tokens and cost by model for one thread, or for every thread; and how full the thread's context is. */
  threadUsage(threadId: string, opts: { all: boolean; mainModel?: string }): ThreadUsage {
    const rows = this.db.all<{ model: string | null; calls: number; input: number; cached: number; cache_write: number; output: number }>(
      `SELECT model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(cached_tokens) AS cached, SUM(cache_write_tokens) AS cache_write, SUM(output_tokens) AS output
       FROM llm_calls ${opts.all ? "" : "WHERE thread_id = ?"} GROUP BY model ORDER BY SUM(input_tokens + output_tokens) DESC`,
      ...(opts.all ? [] : [threadId]),
    );
    const models = rows.map((r) => {
      const t = { input: r.input ?? 0, cached: r.cached ?? 0, cacheWrite: r.cache_write ?? 0, output: r.output ?? 0 };
      return { model: r.model ?? "unknown", calls: r.calls, ...t, cost: this.cost(r.model, t) };
    });
    const last = this.db.get<{ model: string; input_tokens: number; output_tokens: number }>(
      "SELECT model, input_tokens, output_tokens FROM llm_calls WHERE thread_id = ? AND purpose = 'agent' AND error IS NULL AND input_tokens > 0 ORDER BY id DESC LIMIT 1",
      threadId,
    );
    const model = last?.model ?? opts.mainModel;
    return {
      scope: opts.all ? "all" : "thread",
      models,
      context: model ? { model, used: last ? last.input_tokens + last.output_tokens : 0, limit: this.pricing.lookup(model)?.context ?? null } : null,
    };
  }

  byPurpose(): UsageByPurpose[] {
    return this.db
      .all<{ purpose: string; provider: string | null; model: string | null; calls: number; input: number; cached: number; cache_write: number; output: number; avg_ms: number | null }>(
        `SELECT purpose, provider, model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(cached_tokens) AS cached, SUM(cache_write_tokens) AS cache_write,
                SUM(output_tokens) AS output, AVG(duration_ms) AS avg_ms
         FROM llm_calls GROUP BY purpose, provider, model`,
      )
      .map((r) => ({
        purpose: r.purpose,
        provider: r.provider,
        model: r.model,
        calls: r.calls,
        input: r.input ?? 0,
        output: r.output ?? 0,
        cost: this.cost(r.model, { input: r.input ?? 0, cached: r.cached ?? 0, cacheWrite: r.cache_write ?? 0, output: r.output ?? 0 }) ?? 0,
        avgMs: Math.round(r.avg_ms ?? 0),
      }))
      .sort((a, b) => b.cost - a.cost);
  }
}
