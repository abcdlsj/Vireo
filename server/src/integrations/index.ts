import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { GoogleAuth, GoogleCalendar, GoogleMail } from "./google.js";
import { FakeMail, LocalCalendar } from "./local.js";
import type { CalendarProvider, MailProvider } from "./types.js";

export * from "./types.js";

/** Picks the calendar and mail backends that are available right now. */
export class Integrations {
  readonly google: GoogleAuth;
  readonly localCalendar: LocalCalendar;
  readonly fakeMail?: FakeMail;

  constructor(
    private readonly config: Config,
    db: Db,
  ) {
    this.google = new GoogleAuth(db);
    this.localCalendar = new LocalCalendar(db);
    if (config.fakeGoogle) this.fakeMail = new FakeMail();
  }

  calendar(): CalendarProvider {
    if (!this.config.fakeGoogle && this.google.connected()) return new GoogleCalendar(this.google);
    return this.localCalendar;
  }

  mail(): MailProvider | undefined {
    if (this.fakeMail) return this.fakeMail;
    if (this.google.connected()) return new GoogleMail(this.google);
    return undefined;
  }

  status(): { calendar: string; mail: string | null; google: { configured: boolean; connected: boolean; email?: string } } {
    return {
      calendar: this.calendar().name,
      mail: this.mail()?.name ?? null,
      google: {
        configured: Boolean(this.google.client()),
        connected: this.google.connected(),
        email: this.google.tokens()?.email,
      },
    };
  }
}
