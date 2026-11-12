import type { App } from "./app.js";
import type { Risk } from "./tools/types.js";
import { errorMessage, now, truncate } from "./util.js";

/**
 * The risk judge: Cloudflare's clef-flash, a small decision model that answers
 * "does the owner need to look at this before it happens?" with a probability.
 *
 * It is a second opinion, never the authority. A tool's own risk level decides
 * whether the judge is consulted at all (`ask` only; `always` never asks it and
 * never skips a card), a target the owner already trusts is not judged again,
 * and a judge that fails, times out or is over its daily budget leaves the card
 * in place. Everything the model says is a number between 0 and 1 that lowers
 * one card; a prompt injection that wants a silent send has to get past the
 * tool's own risk level and the owner's own trust first.
 *
 * What it sees is the action, not the thread: what the tool is about to do, the
 * target the tool derived itself, the content, and the owner's last request.
 * Clef has zero data retention on Cloudflare's side, and the body is cut short
 * before it leaves the machine.
 */

export const JUDGE_MODEL = "@cf/cloudflare/clef-flash";
/** Clef rates input tokens at 3455 neurons per million; the free allowance is 10,000 neurons a day. */
const DAILY_BUDGET = 500;
const TIMEOUT_MS = 2500;
const CACHE_MS = 10 * 60_000;

export interface JudgeSettings {
  enabled: boolean;
  accountId: string;
  /** The probability above which the owner is shown a card. */
  threshold: number;
}

interface Verdict {
  /** Probability the owner should see this, 0 to 1. */
  need: number;
  kind?: string;
  /** True when the number came from the cache or was over budget, for the log. */
  note?: string;
}

export interface JudgeInput {
  tool: string;
  risk: Risk;
  /** One line as the owner would read the card, e.g. `Send email to anna@example.com: "…"`. */
  summary: string;
  target?: string;
  body?: string;
  /** The owner's last message, so the judge can see that they asked for this. */
  request?: string;
  threadId?: string;
  /** Identifies the call, so the same one is not judged twice within minutes. */
  signature: string;
}

const TOKEN_KEY = "judge.token";
const CALLS_KEY = "judge.calls";

const NOUL = {
  type: "noul" as const,
  instructions:
    "The owner's agent is about to perform this action on their own computer or account. Does the owner need to look at it before it happens? Answer yes when it sends something outward, spends or deletes, changes access, or does something the owner would not expect from their request. Answer no for reading, navigating, filling a field, or doing exactly what the owner asked for in messages they wrote.",
  criteria: {
    true: "outward, irreversible, surprising, or wider than what the owner asked for",
    false: "routine, reversible, or plainly what the owner asked for in their own words",
  },
};

const KIND = {
  type: "choice" as const,
  instructions: "What kind of action is this?",
  criteria: {
    navigate: "reading, switching views, filling a field, no effect outside the app",
    outward: "sending or submitting something to another person or service",
    destructive: "deleting, paying, changing permissions or access",
  },
};

export class Judge {
  /** Overridable in tests; nothing else calls it. */
  transport: typeof fetch = (...args) => fetch(...args);

  constructor(private readonly app: App) {}

  settings(): JudgeSettings {
    const s = this.app.settings.get();
    const accountId = (s.judgeAccountId ?? "").trim();
    return { enabled: Boolean(s.judgeEnabled) && Boolean(accountId) && this.hasToken(), accountId, threshold: s.judgeThreshold ?? 0.5 };
  }

  /** Whether a token is saved. The token itself is encrypted and never returned. */
  hasToken(): boolean {
    return Boolean(this.app.db.getKv<string>(TOKEN_KEY));
  }

  /** The token in clear, for the request only. */
  private token(): string {
    const blob = this.app.db.getKv<string>(TOKEN_KEY);
    if (!blob) return "";
    try {
      return this.app.vault.decrypt(blob);
    } catch {
      return "";
    }
  }

  /** The token, only so the vault can scrub it out of stored text. */
  secret(): string {
    return this.token();
  }

  saveToken(token: string | undefined): void {
    const clean = (token ?? "").trim();
    if (clean) this.app.db.setKv(TOKEN_KEY, this.app.vault.encrypt(clean));
    else this.app.db.setKv(TOKEN_KEY, "");
  }

  /** How many judgements have been made today, against the free allowance. */
  callsToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    const row = this.app.db.getKv<{ day: string; n: number }>(CALLS_KEY);
    return row?.day === day ? row.n : 0;
  }

  private countCall(): void {
    const day = new Date().toISOString().slice(0, 10);
    const row = this.app.db.getKv<{ day: string; n: number }>(CALLS_KEY);
    this.app.db.setKv(CALLS_KEY, { day, n: row?.day === day ? row.n + 1 : 1 });
  }

  /**
   * Ask whether this call needs the owner. `undefined` means "no opinion" — not
   * configured, out of budget, or the request failed — and the caller keeps the
   * card. Never throws.
   */
  async attention(input: JudgeInput): Promise<Verdict | undefined> {
    const cfg = this.settings();
    if (!cfg.enabled) return undefined;
    const cached = this.cached(input.signature);
    if (cached) return { ...cached, note: "cached" };
    if (this.callsToday() >= DAILY_BUDGET) return undefined;

    const body = (input.body ?? "").trim();
    const state = [
      input.request ? `The owner asked, in their own words: ${truncate(input.request.replace(/\s+/g, " "), 300)}` : "",
      `The agent wants to: ${truncate(input.summary.replace(/\s+/g, " "), 500)}`,
      input.target ? `Target: ${truncate(input.target, 120)}` : "",
      body ? `Content that would leave: ${truncate(body, 600)}` : "",
      `Tool: ${input.tool}.`,
    ]
      .filter(Boolean)
      .join("\n");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      this.countCall();
      const res = await this.transport(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/ai/run/${JUDGE_MODEL}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token()}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "clef-flash", state, questions: { need: NOUL, kind: KIND } }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.record(input, undefined, `HTTP ${res.status}`);
        return undefined;
      }
      const json = (await res.json()) as { result?: { answers?: Record<string, { noul?: number; choice?: string }> } };
      const need = json.result?.answers?.need?.noul;
      if (typeof need !== "number" || Number.isNaN(need)) {
        this.record(input, undefined, "no answer");
        return undefined;
      }
      const verdict: Verdict = { need, kind: json.result?.answers?.kind?.choice };
      this.remember(input.signature, verdict);
      this.record(input, verdict);
      return verdict;
    } catch (err) {
      this.record(input, undefined, errorMessage(err));
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The last few verdicts, so Settings can show the judge working. */
  private record(input: JudgeInput, verdict: Verdict | undefined, error?: string): void {
    const log = this.app.db.getKv<{ at: number; tool: string; need?: number; kind?: string; error?: string }[]>("judge.log") ?? [];
    log.unshift({ at: now(), tool: input.tool, need: verdict?.need, kind: verdict?.kind, error });
    this.app.db.setKv("judge.log", log.slice(0, 20));
  }

  recent(): { at: number; tool: string; need?: number; kind?: string; error?: string }[] {
    return this.app.db.getKv("judge.log") ?? [];
  }

  private cache = new Map<string, { at: number; verdict: Verdict }>();

  private cached(signature: string): Verdict | undefined {
    const hit = this.cache.get(signature);
    if (!hit) return undefined;
    if (Date.now() - hit.at > CACHE_MS) {
      this.cache.delete(signature);
      return undefined;
    }
    return hit.verdict;
  }

  private remember(signature: string, verdict: Verdict): void {
    if (this.cache.size > 200) this.cache.clear();
    this.cache.set(signature, { at: Date.now(), verdict });
  }
}
