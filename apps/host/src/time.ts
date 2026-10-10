/** Small time-zone helpers built on Intl, so no date library is needed. */

function parts(ms: number, timeZone: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

/** Offset of a time zone from UTC at an instant, in minutes. */
export function tzOffsetMinutes(ms: number, timeZone: string): number {
  const p = parts(ms, timeZone);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** The UTC instant of a wall-clock time in a time zone. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - tzOffsetMinutes(guess, timeZone) * 60000;
  ms = guess - tzOffsetMinutes(ms, timeZone) * 60000;
  return ms;
}

/** ISO 8601 with the zone's offset, e.g. 2026-10-09T10:00:00+08:00. */
export function toZonedIso(ms: number, timeZone: string): string {
  const p = parts(ms, timeZone);
  const off = tzOffsetMinutes(ms, timeZone);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month!)}-${pad(p.day!)}T${pad(p.hour!)}:${pad(p.minute!)}:${pad(p.second!)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Calendar date (y, m, d) of an instant in a time zone. */
export function zonedDate(ms: number, timeZone: string): { year: number; month: number; day: number; weekday: number } {
  const p = parts(ms, timeZone);
  const weekday = new Date(Date.UTC(p.year!, p.month! - 1, p.day!)).getUTCDay();
  return { year: p.year!, month: p.month!, day: p.day!, weekday };
}

export function hhmm(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(":").map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
}

export interface Slot {
  start: number;
  end: number;
}

/**
 * Free slots of a given length inside working hours on weekdays, avoiding
 * busy intervals. Slots start on the half hour.
 */
export function freeSlots(opts: {
  from: number;
  to: number;
  durationMin: number;
  busy: Slot[];
  timeZone: string;
  workdayStart: string;
  workdayEnd: string;
  includeWeekends?: boolean;
  max?: number;
}): Slot[] {
  const out: Slot[] = [];
  const step = 30 * 60000;
  const dur = opts.durationMin * 60000;
  const busy = [...opts.busy].sort((a, b) => a.start - b.start);
  const ws = hhmm(opts.workdayStart);
  const we = hhmm(opts.workdayEnd);
  let dayCursor = opts.from;
  for (let i = 0; i < 62 && dayCursor < opts.to && out.length < (opts.max ?? 12); i++) {
    const d = zonedDate(dayCursor, opts.timeZone);
    const dayStart = zonedToUtc(d.year, d.month, d.day, ws.hour, ws.minute, opts.timeZone);
    const dayEnd = zonedToUtc(d.year, d.month, d.day, we.hour, we.minute, opts.timeZone);
    if (opts.includeWeekends || (d.weekday !== 0 && d.weekday !== 6)) {
      let t = Math.max(dayStart, Math.ceil(opts.from / step) * step);
      while (t + dur <= Math.min(dayEnd, opts.to) && out.length < (opts.max ?? 12)) {
        const clash = busy.find((b) => b.start < t + dur && b.end > t);
        if (clash) {
          t = Math.ceil(clash.end / step) * step;
          continue;
        }
        out.push({ start: t, end: t + dur });
        t += Math.max(dur, 60 * 60000);
      }
    }
    const next = zonedToUtc(d.year, d.month, d.day, 0, 0, opts.timeZone) + 36 * 3600000;
    const nd = zonedDate(next, opts.timeZone);
    dayCursor = zonedToUtc(nd.year, nd.month, nd.day, 0, 0, opts.timeZone);
  }
  return out;
}
