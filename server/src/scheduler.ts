import type { App } from "./app.js";
import type { CalendarEvent } from "./integrations/types.js";
import { OVERVIEW_ID } from "./threads.js";
import { toZonedIso } from "./time.js";
import { errorMessage, now } from "./util.js";

const INBOX_EVERY = 5 * 60_000;
const CALENDAR_EVERY = 15 * 60_000;

/**
 * Proactive work (C7, C8): reminders and follow-ups, and inbox / calendar
 * checks that open threads when something needs the owner.
 * All state lives in the database, so nothing is lost across restarts.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private readonly app: App) {}

  start(): void {
    if (process.env.VIREO_SCHEDULER === "off") return;
    this.timer = setInterval(() => void this.tick(), this.app.config.schedulerIntervalMs);
    this.timer.unref();
    setTimeout(() => void this.tick(), 2000).unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.fireReminders();
      await this.maybeCheckInbox();
      await this.maybeCheckCalendar();
    } catch (err) {
      console.warn(`[scheduler] ${errorMessage(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  async fireReminders(at = now()): Promise<number> {
    const due = this.app.db.all<{ id: string; thread_id: string | null; kind: string; text: string }>(
      "SELECT * FROM reminders WHERE status = 'scheduled' AND due_at <= ?",
      at,
    );
    for (const r of due) {
      this.app.db.run("UPDATE reminders SET status = 'fired', fired_at = ? WHERE id = ?", now(), r.id);
      const threadId = r.thread_id && this.app.threads.get(r.thread_id) ? r.thread_id : OVERVIEW_ID;
      const thread = this.app.threads.get(threadId)!;
      if (thread.state === "done") this.app.runner.reopen(threadId);
      if (r.kind === "follow_up") {
        this.app.threads.addNotice(threadId, "follow_up", `Follow-up due: ${r.text}. Check whether this is resolved, act if you can, and update the owner.`, {
          llm: true,
        });
        this.app.runner.schedule(threadId);
      } else {
        this.app.threads.addNotice(threadId, "reminder", `Reminder: ${r.text}`, { llm: true });
        if (threadId !== OVERVIEW_ID) this.app.threads.update(threadId, { needs_you: 1 });
      }
      await this.app.push.notify({ title: r.kind === "follow_up" ? `Following up: ${thread.title}` : "Reminder", body: r.text, url: `/#thread/${threadId}`, tag: r.id });
    }
    return due.length;
  }

  private async maybeCheckInbox(): Promise<void> {
    const last = this.app.db.getKv<number>("inbox.checked_at");
    if (last && now() - last < INBOX_EVERY) return;
    await this.checkInbox();
  }

  /** Opens a thread with a summary and a draft for each new email that needs a reply. */
  async checkInbox(): Promise<number> {
    const s = this.app.settings.get();
    const mail = this.app.integrations.mail();
    if (!mail || !s.watchInbox || !this.app.models.mainModel()) return 0;
    const since = this.app.db.getKv<number>("inbox.checked_at") ?? now() - 3600_000;
    this.app.db.setKv("inbox.checked_at", now());
    const handled = new Set(this.app.db.getKv<string[]>("inbox.handled") ?? []);
    let opened = 0;
    for (const m of await mail.newInbox(since)) {
      if (handled.has(m.id)) continue;
      handled.add(m.id);
      const verdict = await this.app.models
        .completeJson<{ needs_reply: boolean; reason?: string }>({
          task: "email_triage",
          system:
            'Decide whether this email needs a personal reply from the owner. Newsletters, notifications, receipts, marketing and automated mail do not. Reply with JSON only: {"needs_reply": true|false, "reason": "..."}',
          prompt: `From: ${m.from}\nSubject: ${m.subject}\n\n${m.snippet}`,
          maxTokens: 120,
        })
        .catch(() => undefined);
      if (!verdict?.needs_reply) continue;
      const sender = m.from.replace(/<.*>/, "").trim() || m.from;
      const thread = this.app.threads.create({ title: `Reply to ${sender}: ${m.subject}`.slice(0, 80), origin: { kind: "email", emailId: m.id }, agent: "email" });
      this.app.threads.addRelated(thread.id, { kind: "email", title: m.subject, ref: m.id, data: { from: m.from, date: m.date } });
      this.app.threads.update(thread.id, { needs_you: 1, status_line: "New email needs a reply" });
      this.app.runner.send(
        thread.id,
        `A new email needs my attention (email id ${m.id}, from ${m.from}, subject "${m.subject}"). Read it, summarise it in two or three lines, and draft a reply in my voice. Save it with draft_email and show me the draft here. Do not send it.`,
        { source: "vireo" },
      );
      this.app.threads.update(thread.id, { needs_you: 1 });
      await this.app.push.notify({ title: `Email from ${sender}`, body: m.subject, url: `/#thread/${thread.id}`, tag: thread.id });
      opened += 1;
    }
    this.app.db.setKv("inbox.handled", [...handled].slice(-500));
    return opened;
  }

  private async maybeCheckCalendar(): Promise<void> {
    const last = this.app.db.getKv<number>("calendar.checked_at");
    if (last && now() - last < CALENDAR_EVERY) return;
    await this.checkCalendar();
  }

  /** Opens threads for invitations awaiting a response and for conflicts. */
  async checkCalendar(): Promise<number> {
    const s = this.app.settings.get();
    if (!s.watchCalendar || !this.app.models.mainModel()) return 0;
    this.app.db.setKv("calendar.checked_at", now());
    const events = await this.app.integrations.calendar().listEvents(new Date(), new Date(now() + 14 * 864e5));
    const handled = new Set(this.app.db.getKv<string[]>("calendar.handled") ?? []);
    let opened = 0;
    const open = (key: string, title: string, brief: string, related: CalendarEvent[]) => {
      if (handled.has(key)) return;
      handled.add(key);
      const thread = this.app.threads.create({ title, origin: { kind: "calendar", key }, agent: "calendar" });
      for (const e of related) this.app.threads.addRelated(thread.id, { kind: "event", title: e.title, ref: e.id, data: { start: e.start, end: e.end } });
      this.app.runner.send(thread.id, brief, { source: "vireo" });
      this.app.threads.update(thread.id, { needs_you: 1 });
      void this.app.push.notify({ title, body: "Vireo opened a thread about your calendar", url: `/#thread/${thread.id}`, tag: thread.id });
      opened += 1;
    };
    for (const e of events) {
      if (e.responseStatus === "needsAction") {
        open(
          `invite:${e.id}`,
          `Invitation: ${e.title}`.slice(0, 80),
          `I was invited to "${e.title}" (event id ${e.id}) at ${toZonedIso(Date.parse(e.start), s.timezone)}${e.organizer ? ` by ${e.organizer}` : ""}. Check it against my calendar, explain any conflict, and offer me options (accept, decline, propose another time). Do not respond to the invitation until I choose.`,
          [e],
        );
      }
    }
    const sorted = events.filter((e) => e.responseStatus !== "declined").sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        if (Date.parse(b.start) >= Date.parse(a.end)) break;
        open(
          `conflict:${[a.id, b.id].sort().join(":")}`,
          `Calendar conflict: ${a.title} / ${b.title}`.slice(0, 80),
          `My calendar has a conflict: "${a.title}" (${a.id}, ${toZonedIso(Date.parse(a.start), s.timezone)}) overlaps "${b.title}" (${b.id}, ${toZonedIso(Date.parse(b.start), s.timezone)}). Explain the conflict and offer concrete options, such as moving one of them to a free slot. Do not change anything until I choose.`,
          [a, b],
        );
      }
    }
    this.app.db.setKv("calendar.handled", [...handled].slice(-500));
    return opened;
  }
}
