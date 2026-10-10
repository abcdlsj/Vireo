import type { App } from "../app.js";
import { messageText, OVERVIEW_ID, type Thread } from "../threads.js";
import { newId, now, safeJson, truncate } from "../util.js";
import { diffCard } from "./diff.js";
import type { Card, CardButton, CardStatus } from "@vireo/protocol";

export type { Card, CardButton, CardStatus };




interface CardRow {
  id: string;
  thread_id: string;
  kind: string;
  title: string;
  status: CardStatus;
  data: string;
  buttons: string;
  archived: number;
  changes: string;
  created_at: number;
  updated_at: number;
}

const ORDER: Record<CardStatus, number> = { needs_you: 0, working: 1, watching: 2, ready: 3, done: 4 };
const DONE_WINDOW = 3 * 864e5;

export class Cards {
  constructor(private readonly app: App) {}

  private toCard(r: CardRow, thread: Thread | undefined): Card {
    const done = thread?.state === "done";
    return {
      id: r.id,
      threadId: r.thread_id,
      threadTitle: thread?.title ?? "",
      kind: r.kind,
      title: r.title,
      status: done ? "done" : r.status,
      data: safeJson(r.data, {}),
      buttons: safeJson(r.buttons, []),
      running: Boolean(thread?.running),
      statusLine: thread?.running ? thread.statusLine : undefined,
      changes: safeJson(r.changes, []),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  get(id: string): Card | undefined {
    const r = this.app.db.get<CardRow>("SELECT * FROM cards WHERE id = ?", id);
    return r ? this.toCard(r, this.app.threads.get(r.thread_id)) : undefined;
  }

  forThread(threadId: string): Card[] {
    const thread = this.app.threads.get(threadId);
    return this.app.db
      .all<CardRow>("SELECT * FROM cards WHERE thread_id = ? AND archived = 0 ORDER BY created_at", threadId)
      .map((r) => this.toCard(r, thread));
  }

  /** Creates a card, or replaces an existing one of this thread when id is given. */
  save(threadId: string, input: { id?: string; kind: string; title: string; status: CardStatus; data: Record<string, unknown>; buttons: CardButton[] }): Card {
    const t = now();
    // Models sometimes make up a card_id ("tokyo-trip") instead of reusing the
    // one they were given. An id this thread doesn't have means the thread's
    // latest card, or a new card when there is none; never another thread's.
    const existing = input.id
      ? (this.app.db.get<CardRow>("SELECT * FROM cards WHERE id = ? AND thread_id = ?", input.id, threadId) ??
        this.app.db.get<CardRow>("SELECT * FROM cards WHERE thread_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 1", threadId))
      : undefined;
    const id = existing?.id ?? newId("card");
    if (existing) {
      // A card that changed kind is a new stage of the matter, not an update.
      const changes = existing.kind === input.kind ? diffCard(safeJson(existing.data, {}), input.data) : [];
      this.app.db.run(
        "UPDATE cards SET kind = ?, title = ?, status = ?, data = ?, buttons = ?, changes = ?, archived = 0, updated_at = ? WHERE id = ?",
        input.kind,
        input.title,
        input.status,
        JSON.stringify(input.data),
        JSON.stringify(input.buttons),
        JSON.stringify(changes),
        t,
        id,
      );
    } else {
      this.app.db.run(
        "INSERT INTO cards (id, thread_id, kind, title, status, data, buttons, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
        id,
        threadId,
        input.kind,
        input.title,
        input.status,
        JSON.stringify(input.data),
        JSON.stringify(input.buttons),
        t,
        t,
      );
    }
    this.changed(threadId, id);
    return this.get(id)!;
  }

  archive(id: string): boolean {
    const r = this.app.db.get<CardRow>("SELECT * FROM cards WHERE id = ?", id);
    if (!r) return false;
    this.app.db.run("UPDATE cards SET archived = 1, updated_at = ? WHERE id = ?", now(), id);
    this.changed(r.thread_id, id);
    return true;
  }

  changed(threadId: string, cardId: string): void {
    this.app.bus.publish({ type: "card.updated", threadId, cardId });
  }

  /** Everything the home page shows, most urgent first. */
  feed(): Card[] {
    const threads = new Map(this.app.threads.list().map((t) => [t.id, t]));
    const out: Card[] = [];
    const withCards = new Set<string>();

    for (const r of this.app.db.all<CardRow>("SELECT * FROM cards WHERE archived = 0 ORDER BY updated_at DESC")) {
      const thread = threads.get(r.thread_id);
      if (!thread || thread.temporary) continue;
      withCards.add(thread.id);
      out.push(this.toCard(r, thread));
    }

    for (const a of this.app.actions.pending()) {
      const thread = threads.get(a.threadId);
      out.push({
        id: `action:${a.id}`,
        threadId: a.threadId,
        threadTitle: thread?.title ?? "",
        kind: "proposal",
        title: a.summary,
        status: "needs_you",
        data: { actionId: a.id, tool: a.tool, args: a.args },
        buttons: [],
        running: false,
        changes: [],
        createdAt: a.createdAt,
        updatedAt: a.createdAt,
      });
      withCards.add(a.threadId);
    }

    for (const thread of threads.values()) {
      if (thread.id === OVERVIEW_ID || thread.temporary || withCards.has(thread.id)) continue;
      out.push(this.threadCard(thread));
    }

    for (const r of this.app.reminders.scheduled({ kind: "reminder", limit: 20 })) {
      out.push({
        id: `reminder:${r.id}`,
        threadId: r.threadId ?? OVERVIEW_ID,
        threadTitle: threads.get(r.threadId ?? OVERVIEW_ID)?.title ?? "",
        kind: "reminder",
        title: r.text,
        status: "watching",
        data: { reminderId: r.id, due: r.dueAt },
        buttons: [],
        running: false,
        changes: [],
        createdAt: r.createdAt,
        updatedAt: r.createdAt,
      });
    }

    const cutoff = now() - DONE_WINDOW;
    return out
      .filter((c) => c.status !== "done" || c.updatedAt > cutoff || (threads.get(c.threadId)?.doneAt ?? 0) > cutoff)
      .sort((a, b) => {
        const sa = a.running && a.status !== "needs_you" ? ORDER.working : ORDER[a.status];
        const sb = b.running && b.status !== "needs_you" ? ORDER.working : ORDER[b.status];
        return sa - sb || b.updatedAt - a.updatedAt;
      });
  }

  /** A thread that has not shown a card yet appears as its latest answer. */
  private threadCard(thread: Thread): Card {
    const last = this.app.threads
      .messages(thread.id, { limit: 8 })
      .reverse()
      .find((m) => m.role === "assistant" && messageText(m.body));
    const status: CardStatus = thread.state === "done" ? "done" : thread.needsYou ? "needs_you" : thread.running ? "working" : "ready";
    return {
      id: `thread:${thread.id}`,
      threadId: thread.id,
      threadTitle: thread.title,
      kind: "thread",
      title: thread.title,
      status,
      data: { text: last ? truncate(messageText(last.body), 600) : "", statusLine: thread.statusLine, browsing: thread.running && this.app.browser.hasPage(thread.id) },
      buttons: [],
      running: thread.running,
      statusLine: thread.running ? thread.statusLine : undefined,
      changes: [],
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  }
}
