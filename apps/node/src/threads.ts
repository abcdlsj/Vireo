import type { AgentMessage, NoticeBody } from "./messages.js";
import type { Bus } from "./bus.js";
import type { Db } from "./db.js";
import { newId, now, safeJson, scoreText, searchTerms } from "./util.js";
import type { Related, Thread } from "@vireo/protocol";

export type { Thread };

export const OVERVIEW_ID = "overview";

export interface ThreadRow {
  id: string;
  title: string;
  state: "active" | "done";
  status_line: string;
  agent: string;
  temporary: number;
  pinned: number;
  running: number;
  needs_you: number;
  summary: string | null;
  origin: string | null;
  titled: number;
  created_at: number;
  updated_at: number;
  last_owner_at: number | null;
  done_at: number | null;
}


export type { NoticeBody } from "./messages.js";

export interface StoredMessage {
  id: number;
  threadId: string;
  role: string;
  agent: string | null;
  llm: boolean;
  body: AgentMessage;
  createdAt: number;
}

export class ThreadStore {
  constructor(
    private readonly db: Db,
    private readonly bus: Bus,
  ) {
    this.ensureOverview();
  }

  private ensureOverview(): void {
    const exists = this.db.get("SELECT id FROM threads WHERE id = ?", OVERVIEW_ID);
    if (!exists) {
      const t = now();
      this.db.run(
        `INSERT INTO threads (id, title, agent, pinned, titled, created_at, updated_at) VALUES (?, 'Overview', 'general', 1, 1, ?, ?)`,
        OVERVIEW_ID,
        t,
        t,
      );
    }
  }

  create(opts: { title?: string; temporary?: boolean; origin?: Record<string, unknown>; agent?: string }): Thread {
    const id = newId("t");
    const t = now();
    this.db.run(
      `INSERT INTO threads (id, title, agent, temporary, origin, titled, created_at, updated_at, status_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      opts.title ?? "New thread",
      opts.agent ?? "triage",
      opts.temporary ? 1 : 0,
      opts.origin ? JSON.stringify(opts.origin) : null,
      opts.title ? 1 : 0,
      t,
      t,
      "",
    );
    this.changed(id);
    return this.get(id)!;
  }

  row(id: string): ThreadRow | undefined {
    return this.db.get<ThreadRow>("SELECT * FROM threads WHERE id = ?", id);
  }

  get(id: string): Thread | undefined {
    const row = this.row(id);
    return row ? this.toThread(row) : undefined;
  }

  list(): Thread[] {
    return this.db
      .all<ThreadRow>("SELECT * FROM threads ORDER BY pinned DESC, updated_at DESC")
      .map((r) => this.toThread(r));
  }

  private toThread(row: ThreadRow): Thread {
    const pending =
      this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM actions WHERE thread_id = ? AND status = 'pending'", row.id)?.n ?? 0;
    const needsYou = row.state !== "done" && (pending > 0 || row.needs_you === 1);
    const group: Thread["group"] =
      row.id === OVERVIEW_ID ? "overview" : row.state === "done" ? "done" : needsYou ? "needs_you" : "in_progress";
    return {
      id: row.id,
      title: row.title,
      state: row.state,
      group,
      statusLine: pending > 0 ? "Waiting for your confirmation" : row.running ? row.status_line || "Working…" : row.status_line,
      agent: row.agent,
      temporary: row.temporary === 1,
      pinned: row.pinned === 1,
      running: row.running === 1,
      needsYou,
      pendingActions: pending,
      summary: row.summary,
      origin: safeJson(row.origin, null),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      doneAt: row.done_at,
    };
  }

  update(id: string, patch: Partial<Pick<ThreadRow, "title" | "state" | "status_line" | "agent" | "running" | "needs_you" | "summary" | "titled" | "done_at" | "last_owner_at" | "temporary">>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => patch[k] as string | number | null);
    this.db.run(`UPDATE threads SET ${sets}, updated_at = ? WHERE id = ?`, ...values, now(), id);
    this.changed(id);
  }

  /** Touch without changing the sort order (used for live status updates). */
  setStatus(id: string, line: string): void {
    this.db.run("UPDATE threads SET status_line = ? WHERE id = ?", line.slice(0, 140), id);
    this.changed(id);
  }

  delete(id: string): void {
    if (id === OVERVIEW_ID) throw new Error("The Overview thread cannot be deleted");
    this.db.run("DELETE FROM threads WHERE id = ?", id);
    this.bus.publish({ type: "thread.deleted", threadId: id });
  }

  changed(id: string): void {
    this.bus.publish({ type: "thread.updated", threadId: id });
  }

  // ---- related items shown in the side panel ----

  addRelated(threadId: string, item: { kind: string; title: string; url?: string; ref?: string; data?: Record<string, unknown> }): void {
    const dup = this.db.get(
      "SELECT id FROM related WHERE thread_id = ? AND kind = ? AND COALESCE(url, '') = ? AND COALESCE(ref, '') = ?",
      threadId,
      item.kind,
      item.url ?? "",
      item.ref ?? "",
    );
    if (dup) return;
    this.db.run(
      "INSERT INTO related (thread_id, kind, title, url, ref, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      threadId,
      item.kind,
      item.title.slice(0, 300),
      item.url ?? null,
      item.ref ?? null,
      item.data ? JSON.stringify(item.data) : null,
      now(),
    );
    this.changed(threadId);
  }

  related(threadId: string): Related[] {
    return this.db
      .all<{ id: number; kind: string; title: string; url: string | null; ref: string | null; data: string | null; created_at: number }>(
        "SELECT * FROM related WHERE thread_id = ? ORDER BY id DESC",
        threadId,
      )
      .map((r) => ({ id: r.id, kind: r.kind, title: r.title, url: r.url, ref: r.ref, data: safeJson<Record<string, unknown> | null>(r.data, null), createdAt: r.created_at }));
  }

  // ---- messages ----

  addMessage(threadId: string, body: AgentMessage, opts: { agent?: string; llm?: boolean } = {}): StoredMessage {
    const t = now();
    const role = (body as { role: string }).role;
    const r = this.db.run(
      "INSERT INTO messages (thread_id, role, agent, body, llm, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      threadId,
      role,
      opts.agent ?? null,
      JSON.stringify(body),
      opts.llm === false ? 0 : 1,
      t,
    );
    this.db.run("UPDATE threads SET updated_at = ? WHERE id = ?", t, threadId);
    this.bus.publish({ type: "message.created", threadId, messageId: r.lastInsertRowid });
    this.changed(threadId);
    return { id: r.lastInsertRowid, threadId, role, agent: opts.agent ?? null, llm: opts.llm !== false, body, createdAt: t };
  }

  addNotice(threadId: string, kind: string, text: string, opts: { data?: Record<string, unknown>; llm?: boolean } = {}): StoredMessage {
    const body: NoticeBody = { role: "notice", kind, text, data: opts.data, timestamp: now() };
    return this.addMessage(threadId, body, { llm: opts.llm ?? false });
  }

  messages(threadId: string, opts: { llmOnly?: boolean; limit?: number } = {}): StoredMessage[] {
    const rows = this.db.all<{ id: number; thread_id: string; role: string; agent: string | null; body: string; llm: number; created_at: number }>(
      `SELECT * FROM (SELECT * FROM messages WHERE thread_id = ? ${opts.llmOnly ? "AND llm = 1" : ""} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
      threadId,
      opts.limit ?? 100000,
    );
    return rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      role: r.role,
      agent: r.agent,
      llm: r.llm === 1,
      body: JSON.parse(r.body) as AgentMessage,
      createdAt: r.created_at,
    }));
  }

  message(id: number): StoredMessage | undefined {
    const r = this.db.get<{ id: number; thread_id: string; role: string; agent: string | null; body: string; llm: number; created_at: number }>(
      "SELECT * FROM messages WHERE id = ?",
      id,
    );
    return r
      ? { id: r.id, threadId: r.thread_id, role: r.role, agent: r.agent, llm: r.llm === 1, body: JSON.parse(r.body), createdAt: r.created_at }
      : undefined;
  }

  /** Plain-text transcript of a thread (owner and Vireo turns only). */
  transcript(threadId: string, opts: { limit?: number; maxChars?: number } = {}): string {
    const lines: string[] = [];
    for (const m of this.messages(threadId, { limit: opts.limit })) {
      const text = messageText(m.body);
      if (!text) continue;
      if (m.role === "user") lines.push(`Owner: ${text}`);
      else if (m.role === "assistant") lines.push(`Vireo: ${text}`);
      else if (m.role === "notice") lines.push(`[${text}]`);
    }
    const all = lines.join("\n");
    const max = opts.maxChars ?? 12000;
    return all.length > max ? all.slice(all.length - max) : all;
  }

  /** Find threads (including closed ones) matching a query. */
  search(query: string, limit = 8): { thread: Thread; score: number; snippet: string }[] {
    const terms = searchTerms(query);
    if (terms.length === 0) return [];
    const out: { thread: Thread; score: number; snippet: string }[] = [];
    for (const row of this.db.all<ThreadRow>("SELECT * FROM threads WHERE temporary = 0 AND id != ?", OVERVIEW_ID)) {
      const head = `${row.title}\n${row.summary ?? ""}`;
      let score = scoreText(terms, head) * 3;
      let snippet = row.summary ?? "";
      const msgs = this.db.all<{ body: string }>(
        "SELECT body FROM messages WHERE thread_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT 60",
        row.id,
      );
      for (const m of msgs) {
        const text = messageText(JSON.parse(m.body));
        const s = scoreText(terms, text);
        if (s > 0) {
          score += s;
          if (!snippet) snippet = text.slice(0, 200);
        }
      }
      if (score > 0) out.push({ thread: this.toThread(row), score, snippet });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

export function messageText(body: AgentMessage | NoticeBody): string {
  const m = body as { role: string; content?: unknown; text?: string };
  if (m.role === "notice") return m.text ?? "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("")
      .trim();
  }
  return "";
}
