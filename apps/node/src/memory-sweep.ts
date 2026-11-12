import type { App } from "./app.js";
import type { Fact } from "@vireo/protocol";
import { OVERVIEW_ID } from "./threads.js";
import { errorMessage, now } from "./util.js";

/**
 * Weekly memory cleanup: memory is where Vireo keeps what lasts, so the one-off
 * details of finished matters — a single booking's date, the state of a task
 * that is over — should not pile up there. Once the owner turns it on, this runs
 * in the quiet hours, asks the cheap model which of the older facts are worth
 * keeping, and deletes only the ids it was shown. Preferences, identity, how-to
 * knowledge and anything recent are never candidates.
 *
 * This is Vireo's own upkeep, not an agent action, so it does not ask for a
 * confirmation — the owner's opt-in is the decision. Every run leaves a line in
 * the home thread saying what went, and Settings shows the last run.
 */

/** Facts younger than this are never swept: a recent matter's details may still matter. */
const MIN_AGE_DAYS = 14;
/** Slots that are the point of long-term memory. Never swept, whatever the model says. */
const KEEP_SLOT = /^(account\.|preference\.|identity\.|home_|work_|birthday|employer|phone$|email$|address)/i;
/** One run deletes at most this many, so a bad judgement stays small. */
const MAX_REMOVE = 20;
/** How many facts one run shows the model. */
const PROMPT_LIMIT = 80;
const WEEK_MS = 7 * 864e5;
/** A node that is asleep at night catches up after this, rather than never sweeping. */
const OVERDUE_MS = 2 * WEEK_MS;
const QUIET_FROM = 1;
const QUIET_TO = 6;

export interface SweepResult {
  at: number;
  /** How many older facts the model was shown. */
  considered: number;
  removed: { id: string; statement: string; reason?: string }[];
}

const SYSTEM = [
  "You keep the long-term memory of a personal assistant tidy. You are given the facts it currently holds, with their age, slot and the matter each came from.",
  "Choose the facts that are no longer worth keeping: one-off details of a finished matter (a single booking or appointment that has passed, the state or progress of a task that is over, a temporary arrangement, a duplicate that the rest makes redundant).",
  "Keep: preferences, identity and contact details, relationships, how the owner wants kinds of tasks done, anything still current or recurring, and anything you are unsure about.",
  "When in doubt, keep it. Deleting a fact the owner cared about is worse than keeping a stale one.",
  'Reply with JSON only: {"delete":[{"id":"<id from the list>","reason":"<eight words at most>"}]}. Return {"delete":[]} when nothing should go.',
].join("\n");

export class MemorySweep {
  constructor(private readonly app: App) {}

  /** Whether a run is wanted now, without starting the clock. */
  due(at = now()): boolean {
    const s = this.app.settings.get();
    if (!s.memorySweep) return false;
    const last = this.app.db.getKv<number>("memory.sweep.last");
    if (!last) return false;
    const age = at - last;
    if (age < WEEK_MS) return false;
    if (age >= OVERDUE_MS) return true;
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: s.timezone }).format(new Date(at)),
    );
    return hour >= QUIET_FROM && hour < QUIET_TO;
  }

  /** Runs the sweep if it is due. Returns undefined when it was not. */
  async maybeRun(at = now()): Promise<SweepResult | undefined> {
    if (!this.app.settings.get().memorySweep) return undefined;
    // Turning it on starts the clock: the first cleanup is a week later, not now.
    if (this.app.db.getKv<number>("memory.sweep.last") === undefined) {
      this.app.db.setKv("memory.sweep.last", at);
      return undefined;
    }
    if (!this.due(at)) return undefined;
    return this.run(at);
  }

  /** The older facts the model is allowed to judge: current, not a protected slot, not how-to. */
  candidates(at = now()): Fact[] {
    const cutoff = at - MIN_AGE_DAYS * 864e5;
    return this.app.memory
      .list()
      .filter((f) => f.current && f.createdAt <= cutoff && f.kind !== "procedural" && !KEEP_SLOT.test(f.key))
      .slice(0, PROMPT_LIMIT);
  }

  /** One sweep, now. Deletes nothing it was not shown. */
  async run(at = now()): Promise<SweepResult> {
    const candidates = this.candidates(at);
    const result: SweepResult = { at, considered: candidates.length, removed: [] };
    if (candidates.length) {
      const prompt = candidates
        .map((f) => `${f.id} | ${Math.round((at - f.createdAt) / 864e5)} days old | ${f.entityName}/${f.key} | ${f.statement} | from "${f.sourceThreadTitle ?? "no matter"}"`)
        .join("\n");
      const answer = await this.app.models
        .completeJson<{ delete?: { id?: string; reason?: string }[] }>({ task: "memory_sweep", tier: "fast", system: SYSTEM, prompt, maxTokens: 800 })
        .catch((err) => {
          console.warn(`[memory-sweep] ${errorMessage(err)}`);
          return undefined;
        });
      const byId = new Map(candidates.map((f) => [f.id, f]));
      for (const pick of answer?.delete ?? []) {
        const fact = byId.get(String(pick.id ?? ""));
        // Only the facts it was shown, and only so many: a hallucinated id deletes nothing.
        if (!fact || result.removed.length >= MAX_REMOVE) continue;
        if (!this.app.memory.delete(fact.id)) continue;
        result.removed.push({ id: fact.id, statement: fact.statement, reason: pick.reason?.slice(0, 80) });
      }
      // No answer at all: leave the clock alone so the next tick tries again.
      if (answer === undefined) return result;
    }
    this.finish(result);
    return result;
  }

  /** The last run, or undefined when it has not run yet. */
  last(): SweepResult | undefined {
    return this.app.db.getKv<SweepResult>("memory.sweep.result");
  }

  private finish(result: SweepResult): void {
    this.app.db.setKv("memory.sweep.last", result.at);
    this.app.db.setKv("memory.sweep.result", result);
    if (!result.removed.length) return;
    const said = result.removed.slice(0, 6).map((r) => `"${r.statement}"`).join(", ");
    const more = result.removed.length > 6 ? `, and ${result.removed.length - 6} more` : "";
    this.app.threads.addNotice(
      OVERVIEW_ID,
      "memory_sweep",
      `Weekly memory cleanup removed ${result.removed.length} of ${result.considered} older facts: ${said}${more}. Preferences, identity and current matters were kept.`,
      { data: { removed: result.removed.map((r) => r.statement) } },
    );
  }
}
