import type { Db } from "./db.js";
import { applyProxy } from "./net.js";
import type { OwnerSettings } from "@vireo/protocol";

export type { OwnerSettings };


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
