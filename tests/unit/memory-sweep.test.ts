import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../apps/node/src/app.js";
import { OVERVIEW_ID } from "../../apps/node/src/threads.js";
import { testApp } from "./helpers.js";

let apps: App[] = [];
afterEach(() => {
  for (const app of apps) {
    try {
      app.db.close();
    } catch {
      // already closed
    }
  }
  apps = [];
});

function open(): App {
  const app = testApp();
  apps.push(app);
  return app;
}

const DAY = 864e5;

/** A fact, with the age it should have. */
function fact(app: App, statement: string, key: string, ageDays: number, opts: { procedural?: boolean } = {}) {
  const r = app.memory.addFact({ statement, key, kind: opts.procedural ? "procedural" : "semantic" });
  app.db.run("UPDATE facts SET created_at = ?, updated_at = ? WHERE id = ?", Date.now() - ageDays * DAY, Date.now() - ageDays * DAY, r.fact.id);
  return r.fact.id;
}

/** A quiet hour in the owner's own time zone, so `due()` sees what a real night would. */
function quietHour(app: App): number {
  const tz = app.settings.get().timezone;
  const now = Date.now();
  for (let h = 0; h < 48; h++) {
    const at = now + h * 3600_000;
    const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(new Date(at)));
    if (hour === 3) return at;
  }
  return now;
}

describe("weekly memory cleanup", () => {
  it("does nothing until the owner turns it on", async () => {
    const app = open();
    fact(app, "Trip to Kyoto in April 2026", "trip.kyoto", 100);
    expect(await app.memorySweep.maybeRun(quietHour(app))).toBeUndefined();
    expect(app.memory.list()).toHaveLength(1);
  });

  it("starts the clock when it is turned on, and runs after a week in the quiet hours", async () => {
    const app = open();
    app.settings.update({ memorySweep: true });
    const on = quietHour(app);
    // The first tick only starts the clock.
    expect(await app.memorySweep.maybeRun(on)).toBeUndefined();
    expect(app.db.getKv<number>("memory.sweep.last")).toBe(on);
    // Less than a week later, nothing.
    expect(app.memorySweep.due(on + 5 * DAY)).toBe(false);
    // A week and a night: due, and maybeRun actually sweeps.
    fact(app, "Old one-off note", "note.old", 40);
    app.models.completeJson = (async () => ({ delete: [] })) as never;
    const later = on + 8 * DAY;
    expect(app.memorySweep.due(later)).toBe(true);
    const ran = await app.memorySweep.maybeRun(later);
    expect(ran).toMatchObject({ considered: 1 });
    expect(app.db.getKv<number>("memory.sweep.last")).toBe(later);
  });

  it("never shows the model recent facts, preferences, identity or how-to", async () => {
    const app = open();
    fact(app, "Owner prefers aisle seats", "preference.seat", 100);
    fact(app, "Owner's email is l@example.com", "email", 100);
    fact(app, "Booking reference KX-8821 for Kyoto", "booking.kyoto", 100);
    fact(app, "Booked table for two on Friday", "booking.table", 3);
    fact(app, "How to file an expense", "expense.how", 100, { procedural: true });
    const keys = app.memorySweep.candidates().map((f) => f.key);
    expect(keys).toEqual(["booking.kyoto"]);
  });

  it("deletes only what the model picked from the list it was shown", async () => {
    const app = open();
    const stale = fact(app, "Table for two at 19:00 last Friday", "booking.table", 40);
    const other = fact(app, "Visited the Kyoto office", "visit.kyoto", 40);
    let prompt = "";
    app.models.completeJson = (async (opts: { prompt: string }) => {
      prompt = opts.prompt;
      return { delete: [ { id: stale, reason: "one-off booking that has passed" }, { id: "f_made_up", reason: "invented" } ] };
    }) as never;

    const result = await app.memorySweep.run();
    expect(prompt).toContain("Table for two at 19:00 last Friday");
    expect(result.considered).toBe(2);
    expect(result.removed.map((r) => r.id)).toEqual([stale]);
    expect(app.memory.fact(stale)).toBeUndefined();
    expect(app.memory.fact(other)).toBeDefined();
    // The owner sees what went, in the home thread.
    const notices = app.threads.messages(OVERVIEW_ID).filter((m) => m.role === "notice").map((m) => JSON.stringify(m.body)).join(" ");
    expect(notices).toContain("Weekly memory cleanup removed 1 of 2");
    expect(notices).toContain("Table for two at 19:00 last Friday");
    expect(app.memorySweep.last()).toMatchObject({ considered: 2 });
  });

  it("keeps every fact when the model cannot answer, and tries again", async () => {
    const app = open();
    fact(app, "Old one-off note", "note.old", 40);
    app.models.completeJson = (async () => {
      throw new Error("model down");
    }) as never;
    const at = quietHour(app);
    app.db.setKv("memory.sweep.last", at - 8 * DAY);
    const result = await app.memorySweep.run(at);
    expect(result.removed).toEqual([]);
    expect(app.memory.list()).toHaveLength(1);
    // The clock was not moved, so the next tick tries again.
    expect(app.db.getKv<number>("memory.sweep.last")).toBe(at - 8 * DAY);
  });

  it("removes nothing when there is nothing old to judge", async () => {
    const app = open();
    fact(app, "A fresh detail", "note.fresh", 2);
    app.models.completeJson = (async () => {
      throw new Error("should not be called");
    }) as never;
    const result = await app.memorySweep.run();
    expect(result).toMatchObject({ considered: 0, removed: [] });
  });
});
