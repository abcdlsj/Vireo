import type { Db } from "./db.js";

/** Owner preferences that change Vireo's behaviour. */
export interface OwnerSettings {
  /** IANA time zone, detected from the owner's browser. */
  timezone: string;
  /** Local time of the daily brief, "HH:MM". Empty disables it. */
  briefTime: string;
  /** Working hours used when looking for free slots. */
  workdayStart: string;
  workdayEnd: string;
  /** Check the inbox and open threads for mail that needs a reply. */
  watchInbox: boolean;
  /** Gmail search used to pick which mail to watch. */
  inboxQuery: string;
  /** Check the calendar for invitations and conflicts. */
  watchCalendar: boolean;
  /** Days without activity before a thread is mentioned as quiet in the brief. */
  staleDays: number;
}

const DEFAULTS: OwnerSettings = {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  briefTime: "08:00",
  workdayStart: "09:00",
  workdayEnd: "18:00",
  watchInbox: true,
  inboxQuery: "in:inbox is:unread category:primary",
  watchCalendar: true,
  staleDays: 7,
};

export class Settings {
  constructor(private readonly db: Db) {}

  get(): OwnerSettings {
    return { ...DEFAULTS, ...(this.db.getKv<Partial<OwnerSettings>>("settings") ?? {}) };
  }

  update(patch: Partial<OwnerSettings>): OwnerSettings {
    const next = { ...this.get(), ...patch };
    this.db.setKv("settings", next);
    return next;
  }
}
