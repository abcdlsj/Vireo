import { randomBytes, createHash } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function now(): number {
  return Date.now();
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text;
}

export function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Splits text into lowercase search terms; CJK text is split into bigrams. */
export function searchTerms(text: string): string[] {
  const terms = new Set<string>();
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z0-9][a-z0-9'_-]{1,}/g) ?? []) {
    if (!STOPWORDS.has(word)) terms.add(word);
  }
  for (const run of lower.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) terms.add(run);
    for (let i = 0; i + 1 < run.length; i++) terms.add(run.slice(i, i + 2));
  }
  return [...terms];
}

export function scoreText(terms: string[], text: string): number {
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const t of terms) if (lower.includes(t)) score += t.length > 3 ? 2 : 1;
  return score;
}

const STOPWORDS = new Set(
  "the a an and or but of to in on for with at by from is are was were be been it this that these those what which who whom how when where why do does did i me my you your we our they them their he she his her its as about into over than then so if not no yes can could should would will shall may might must have has had just also please tell know remember".split(
    " ",
  ),
);

export function formatDate(ms: number, timeZone?: string): string {
  try {
    return new Date(ms).toLocaleString("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
