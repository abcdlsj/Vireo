import type { Db } from "../db.js";
import { newId, now, safeJson } from "../util.js";
import type {
  CalendarEvent,
  CalendarProvider,
  DriveFile,
  DriveProvider,
  Email,
  EmailSummary,
  MailProvider,
  NewEvent,
  OutgoingEmail,
} from "./types.js";

/**
 * Built-in calendar stored in Vireo's own database. It is what Vireo uses
 * until Google Calendar is connected, so scheduling works out of the box.
 */
export class LocalCalendar implements CalendarProvider {
  readonly name = "Vireo calendar";
  constructor(private readonly db: Db) {}

  async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    return this.db
      .all<{ id: string; title: string; start_at: number; end_at: number; attendees: string; location: string | null; description: string | null }>(
        "SELECT * FROM local_events WHERE end_at > ? AND start_at < ? ORDER BY start_at",
        from.getTime(),
        to.getTime(),
      )
      .map((r) => ({
        id: r.id,
        title: r.title,
        start: new Date(r.start_at).toISOString(),
        end: new Date(r.end_at).toISOString(),
        attendees: safeJson<string[]>(r.attendees, []),
        location: r.location ?? undefined,
        description: r.description ?? undefined,
        responseStatus: "accepted",
      }));
  }

  async createEvent(e: NewEvent): Promise<CalendarEvent> {
    const id = newId("ev");
    this.db.run(
      "INSERT INTO local_events (id, title, start_at, end_at, attendees, location, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      e.title,
      Date.parse(e.start),
      Date.parse(e.end),
      JSON.stringify(e.attendees ?? []),
      e.location ?? null,
      e.description ?? null,
      now(),
    );
    return (await this.get(id))!;
  }

  private async get(id: string): Promise<CalendarEvent | undefined> {
    const all = await this.listEvents(new Date(0), new Date(8.64e15));
    return all.find((e) => e.id === id);
  }

  async updateEvent(id: string, patch: Partial<NewEvent>): Promise<CalendarEvent> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`Event ${id} not found`);
    const next = { ...cur, ...patch };
    this.db.run(
      "UPDATE local_events SET title = ?, start_at = ?, end_at = ?, attendees = ?, location = ?, description = ? WHERE id = ?",
      next.title,
      Date.parse(next.start),
      Date.parse(next.end),
      JSON.stringify(next.attendees ?? []),
      next.location ?? null,
      next.description ?? null,
      id,
    );
    return (await this.get(id))!;
  }

  async deleteEvent(id: string): Promise<void> {
    this.db.run("DELETE FROM local_events WHERE id = ?", id);
  }

  async respond(id: string): Promise<CalendarEvent> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`Event ${id} not found`);
    return cur;
  }
}

/**
 * In-memory mailbox used by tests and demos (VIREO_FAKE_GOOGLE=1). Sent mail
 * is recorded so tests can assert that nothing left without confirmation.
 */
export class FakeMail implements MailProvider {
  readonly name = "Demo mailbox";
  readonly inbox: Email[] = [];
  readonly sent: (OutgoingEmail & { id: string; at: number })[] = [];
  readonly drafts: (OutgoingEmail & { id: string })[] = [];

  deliver(mail: { from: string; subject: string; body: string; to?: string }): Email {
    const id = newId("m");
    const email: Email = {
      id,
      threadId: id,
      from: mail.from,
      to: mail.to ?? "owner@example.com",
      subject: mail.subject,
      snippet: mail.body.slice(0, 140),
      body: mail.body,
      date: new Date().toISOString(),
      unread: true,
    };
    this.inbox.unshift(email);
    return email;
  }

  async search(query: string, max: number): Promise<EmailSummary[]> {
    const q = query.toLowerCase().replace(/\b(is:\w+|in:\w+|newer_than:\w+)\b/g, "").trim();
    return this.inbox
      .filter((m) => !q || `${m.from} ${m.subject} ${m.body}`.toLowerCase().includes(q))
      .slice(0, max)
      .map(({ body: _body, ...rest }) => rest);
  }

  async get(id: string): Promise<Email> {
    const m = this.inbox.find((x) => x.id === id);
    if (!m) throw new Error(`Email ${id} not found`);
    m.unread = false;
    return m;
  }

  async newInbox(sinceMs: number): Promise<EmailSummary[]> {
    return this.inbox.filter((m) => m.unread && Date.parse(m.date) > sinceMs).map(({ body: _body, ...rest }) => rest);
  }

  async createDraft(mail: OutgoingEmail): Promise<{ id: string }> {
    const id = newId("d");
    this.drafts.push({ ...mail, id });
    return { id };
  }

  async send(mail: OutgoingEmail): Promise<{ id: string }> {
    const id = newId("s");
    this.sent.push({ ...mail, id, at: now() });
    return { id };
  }

  async ownerAddress(): Promise<string | undefined> {
    return "owner@example.com";
  }
}

/** In-memory Drive for tests and demos (VIREO_FAKE_GOOGLE=1). */
export class FakeDrive implements DriveProvider {
  readonly files: (DriveFile & { text: string })[] = [
    {
      id: "doc_trip",
      name: "Lisbon trip plan",
      mimeType: "application/vnd.google-apps.document",
      modifiedTime: "2026-09-30T10:00:00Z",
      webViewLink: "https://docs.google.com/document/d/doc_trip",
      text: "Lisbon, 12–16 November. Hotel: Casa do Rio, confirmation LX-4821. Dinner booked at Taberna on the 13th.",
    },
    {
      id: "sheet_budget",
      name: "2026 budget",
      mimeType: "application/vnd.google-apps.spreadsheet",
      modifiedTime: "2026-09-12T08:00:00Z",
      webViewLink: "https://docs.google.com/spreadsheets/d/sheet_budget",
      text: "Category,Amount\nTravel,2400\nBooks,300",
    },
  ];

  async search(query: string, max: number): Promise<DriveFile[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.files
      .filter((f) => terms.some((t) => `${f.name} ${f.text}`.toLowerCase().includes(t)))
      .slice(0, max)
      .map(({ text: _text, ...rest }) => rest);
  }

  async read(id: string): Promise<{ file: DriveFile; text: string }> {
    const f = this.files.find((x) => x.id === id);
    if (!f) throw new Error(`No Drive file ${id}`);
    const { text, ...file } = f;
    return { file, text };
  }
}
