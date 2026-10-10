import type { Reminder } from "@vireo/protocol";
import type { Bus } from "./bus.js";
import type { Db } from "./db.js";
import { OVERVIEW_ID } from "./threads.js";
import { newId, now } from "./util.js";

interface Row {
  id: string;
  thread_id: string | null;
  kind: Reminder["kind"];
  text: string;
  due_at: number;
  created_at: number;
}

const toReminder = (r: Row): Reminder => ({ id: r.id, threadId: r.thread_id, kind: r.kind, text: r.text, dueAt: r.due_at, createdAt: r.created_at });

/** Reminders for the owner and follow-ups Vireo set for itself; the scheduler fires them. */
export class Reminders {
  constructor(
    private readonly db: Db,
    private readonly bus: Bus,
  ) {}

  add(r: { threadId: string; kind: Reminder["kind"]; text: string; dueAt: number }): string {
    const id = newId("rem");
    this.db.run("INSERT INTO reminders (id, thread_id, kind, text, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, r.threadId, r.kind, r.text, r.dueAt, now());
    this.bus.publish({ type: "card.updated", threadId: r.threadId, cardId: `reminder:${id}` });
    return id;
  }

  scheduled(opts: { kind?: Reminder["kind"]; limit?: number } = {}): Reminder[] {
    return this.db
      .all<Row>(`SELECT * FROM reminders WHERE status = 'scheduled' ${opts.kind ? "AND kind = ?" : ""} ORDER BY due_at LIMIT ?`, ...(opts.kind ? [opts.kind] : []), opts.limit ?? 500)
      .map(toReminder);
  }

  /** Reminders due by the given time, each marked fired as it is handed out. */
  takeDue(at: number): Reminder[] {
    const due = this.db.all<Row>("SELECT * FROM reminders WHERE status = 'scheduled' AND due_at <= ?", at).map(toReminder);
    for (const r of due) this.db.run("UPDATE reminders SET status = 'fired', fired_at = ? WHERE id = ?", now(), r.id);
    return due;
  }

  /** Cancels a scheduled reminder; undefined when there is none with that id. */
  cancel(id: string): Reminder | undefined {
    const r = this.db.get<Row>("SELECT * FROM reminders WHERE id = ? AND status = 'scheduled'", id);
    if (!r) return undefined;
    this.db.run("UPDATE reminders SET status = 'cancelled' WHERE id = ?", id);
    this.bus.publish({ type: "card.updated", threadId: r.thread_id ?? OVERVIEW_ID, cardId: `reminder:${id}` });
    return toReminder(r);
  }
}
