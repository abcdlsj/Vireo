import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { FakeDrive, GoogleAuth, GoogleCalendar, GoogleDrive, GoogleMail, type DriveProvider, type GoogleClient } from "../plugins/google/api.js";
import { FakeMail, LocalCalendar } from "./local.js";
import type { CalendarProvider, MailProvider } from "./types.js";

export * from "./types.js";

/**
 * Picks the calendar, mail and Drive backends that are available right now.
 * Google backends come from the Google plugin; without it Vireo keeps events
 * in its own calendar.
 */
export class Integrations {
  readonly google: GoogleAuth;
  readonly localCalendar: LocalCalendar;
  readonly fakeMail?: FakeMail;
  readonly fakeDrive?: FakeDrive;
  /** Set once plugins are loaded. */
  googleEnabled: () => boolean = () => false;
  googleClient: () => GoogleClient | undefined = () => undefined;

  constructor(
    private readonly config: Config,
    db: Db,
  ) {
    this.google = new GoogleAuth(db, () => this.googleClient());
    this.localCalendar = new LocalCalendar(db);
    if (config.fakeGoogle) {
      this.fakeMail = new FakeMail();
      this.fakeDrive = new FakeDrive();
    }
  }

  private googleConnected(): boolean {
    return this.googleEnabled() && this.google.connected();
  }

  calendar(): CalendarProvider {
    if (!this.config.fakeGoogle && this.googleConnected()) return new GoogleCalendar(this.google);
    return this.localCalendar;
  }

  mail(): MailProvider | undefined {
    if (this.fakeMail) return this.fakeMail;
    if (this.googleConnected()) return new GoogleMail(this.google);
    return undefined;
  }

  drive(): DriveProvider | undefined {
    if (this.fakeDrive) return this.fakeDrive;
    if (this.googleConnected()) return new GoogleDrive(this.google);
    return undefined;
  }

  status(): { calendar: string; mail: string | null; google: { installed: boolean; configured: boolean; connected: boolean; email?: string } } {
    return {
      calendar: this.calendar().name,
      mail: this.mail()?.name ?? null,
      google: {
        installed: this.googleEnabled(),
        configured: Boolean(this.google.client()),
        connected: this.googleConnected(),
        email: this.google.tokens()?.email,
      },
    };
  }
}
