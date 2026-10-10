import { describe, expect, it } from "vitest";
import { freeSlots, toZonedIso, zonedToUtc } from "../../apps/node/src/time.js";

const TZ = "Asia/Shanghai";
const at = (h: number, m = 0) => zonedToUtc(2026, 10, 12, h, m, TZ); // a Monday

describe("time helpers", () => {
  it("converts between wall-clock time and UTC", () => {
    expect(new Date(at(9)).toISOString()).toBe("2026-10-12T01:00:00.000Z");
    expect(toZonedIso(at(9), TZ)).toMatch(/^2026-10-12T09:00(:00)?\+08:00$/);
    // Daylight saving: 9:00 in New York is UTC-4 in summer and UTC-5 in winter.
    expect(new Date(zonedToUtc(2026, 7, 1, 9, 0, "America/New_York")).getUTCHours()).toBe(13);
    expect(new Date(zonedToUtc(2026, 12, 1, 9, 0, "America/New_York")).getUTCHours()).toBe(14);
  });

  it("finds free slots inside working hours, avoiding busy time", () => {
    const slots = freeSlots({
      from: at(0),
      to: at(23),
      durationMin: 60,
      busy: [{ start: at(9), end: at(11, 15) }],
      timeZone: TZ,
      workdayStart: "09:00",
      workdayEnd: "18:00",
    });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0]!.start).toBe(at(11, 30));
    for (const s of slots) {
      expect(s.end - s.start).toBe(3600_000);
      expect(s.start).toBeGreaterThanOrEqual(at(9));
      expect(s.end).toBeLessThanOrEqual(at(18));
      expect(s.start >= at(11, 15) || s.end <= at(9)).toBe(true);
    }
  });

  it("skips weekends unless asked", () => {
    const sat = (h: number) => zonedToUtc(2026, 10, 10, h, 0, TZ);
    const opts = { from: sat(0), to: sat(23), durationMin: 30, busy: [], timeZone: TZ, workdayStart: "09:00", workdayEnd: "18:00" };
    expect(freeSlots(opts)).toHaveLength(0);
    expect(freeSlots({ ...opts, includeWeekends: true }).length).toBeGreaterThan(0);
  });
});
