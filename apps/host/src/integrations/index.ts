import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { Providers } from "../plugins/types.js";
import { FakeDrive, FakeMail, LocalCalendar } from "./local.js";
import type { CalendarProvider, DriveProvider, MailProvider } from "./types.js";

export * from "./types.js";

/**
 * Picks the calendar, mail and Drive backends that are available right now:
 * the first added plugin that provides one (Google), else Vireo's own
 * calendar. Demo mode uses an in-memory mailbox and Drive.
 */
export class Integrations {
  readonly localCalendar: LocalCalendar;
  readonly fakeMail?: FakeMail;
  readonly fakeDrive?: FakeDrive;

  constructor(
    config: Config,
    db: Db,
    /** Providers of the plugins the owner has added. */
    private readonly fromPlugins: () => Providers[],
  ) {
    this.localCalendar = new LocalCalendar(db);
    if (config.fakeGoogle) {
      this.fakeMail = new FakeMail();
      this.fakeDrive = new FakeDrive();
    }
  }

  private first<T>(pick: (p: Providers) => T | undefined): T | undefined {
    for (const p of this.fromPlugins()) {
      const hit = pick(p);
      if (hit) return hit;
    }
    return undefined;
  }

  calendar(): CalendarProvider {
    return this.first((p) => p.calendar?.()) ?? this.localCalendar;
  }

  mail(): MailProvider | undefined {
    return this.fakeMail ?? this.first((p) => p.mail?.());
  }

  drive(): DriveProvider | undefined {
    return this.fakeDrive ?? this.first((p) => p.drive?.());
  }

  status(): { calendar: string; mail: string | null; drive: boolean } {
    return { calendar: this.calendar().name, mail: this.mail()?.name ?? null, drive: Boolean(this.drive()) };
  }
}
