import type { Db } from "./db.js";
import { applyProxy } from "./net.js";

/** Owner preferences that change Vireo's behaviour. */
export interface OwnerSettings {
  /** IANA time zone, detected from the owner's browser. */
  timezone: string;
  /** Local time of the daily "things need you" notification, "HH:MM". Empty disables it. */
  nudgeTime: string;
  /** Working hours used when looking for free slots. */
  workdayStart: string;
  workdayEnd: string;
  /** Check the inbox and open threads for mail that needs a reply. */
  watchInbox: boolean;
  /** Gmail search used to pick which mail to watch. */
  inboxQuery: string;
  /** Check the calendar for invitations and conflicts. */
  watchCalendar: boolean;
  /** HTTP proxy for web search, page fetches and the browser, e.g. "http://127.0.0.1:7890". Empty connects directly. */
  proxyUrl: string;
}

const DEFAULTS: OwnerSettings = {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  nudgeTime: "09:00",
  workdayStart: "09:00",
  workdayEnd: "18:00",
  watchInbox: true,
  inboxQuery: "in:inbox is:unread category:primary",
  watchCalendar: true,
  proxyUrl: "",
};

export class Settings {
  constructor(private readonly db: Db) {
    applyProxy(this.get().proxyUrl);
  }

  get(): OwnerSettings {
    return { ...DEFAULTS, ...(this.db.getKv<Partial<OwnerSettings>>("settings") ?? {}) };
  }

  update(patch: Partial<OwnerSettings>): OwnerSettings {
    const next = { ...this.get(), ...patch };
    this.db.setKv("settings", next);
    applyProxy(next.proxyUrl);
    return next;
  }
}
