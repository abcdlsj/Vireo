import type { App } from "./app.js";
import { OVERVIEW_ID } from "./threads.js";
import { now, truncate } from "./util.js";

/** A thread's life outside of runs: its title, being marked done, and reopening. */
export class ThreadLifecycle {
  constructor(private readonly app: App) {}

  /** Names a thread from its first message (e.g. "Book flight to Shanghai, Oct 15"). */
  async nameThread(threadId: string, firstMessage: string): Promise<void> {
    this.app.threads.update(threadId, { titled: 1, title: fallbackTitle(firstMessage) });
    // The fast model first; if it fails or says nothing (a reasoning model can
    // spend a small budget on thinking), the main model. Else the fallback stays.
    for (const tier of ["fast", "main"] as const) {
      try {
        const title = await this.app.models.complete({
          task: "thread_title",
          threadId,
          tier,
          system:
            "Name this matter for a to-do style list. Reply with the title only: at most 7 words, in the same language as the message, specific (include names, places, dates when present), no quotes, no trailing punctuation. Example: Book flight to Shanghai, Oct 15",
          prompt: firstMessage.slice(0, 2000),
          maxTokens: 400,
        });
        const clean = title.replace(/^["'“”]+|["'“”.。]+$/g, "").split("\n")[0]!.trim();
        if (clean) {
          this.app.threads.update(threadId, { title: truncate(clean, 80) });
          return;
        }
      } catch {
        // try the next tier
      }
    }
  }

  /** Marks a thread done: one-line summary, lasting conclusions to memory (M4). */
  async complete(threadId: string): Promise<void> {
    const thread = this.app.threads.get(threadId);
    if (!thread || thread.id === OVERVIEW_ID || thread.state === "done") return;
    await this.app.runner.settled(threadId);
    let summary = thread.statusLine || thread.title;
    try {
      summary = await this.app.models.complete({
        task: "thread_summary",
        threadId,
        system:
          "Summarise the outcome of this matter in one line (max 20 words), in the language of the conversation. State what was decided or done, not the process.",
        prompt: this.app.threads.transcript(threadId, { maxChars: 10000 }),
        maxTokens: 80,
      });
    } catch {
      // keep the fallback summary
    }
    summary = truncate(summary.split("\n")[0]!.trim(), 200);
    this.app.threads.update(threadId, { state: "done", done_at: now(), summary, status_line: summary, needs_you: 0 });
    this.app.threads.addNotice(threadId, "done", `Marked done: ${summary}`);
    void this.app.browser.closeThread(threadId);
    if (!thread.temporary) await this.app.memoryWorker.distill(threadId, summary);
  }

  reopen(threadId: string): void {
    const thread = this.app.threads.get(threadId);
    if (!thread || thread.state !== "done") return;
    this.app.threads.update(threadId, { state: "active", done_at: null });
    this.app.threads.addNotice(threadId, "reopened", "Reopened");
  }
}

function fallbackTitle(text: string): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  const cjk = /[㐀-鿿]/.test(firstLine);
  return truncate(cjk ? firstLine.slice(0, 20) : firstLine.split(/\s+/).slice(0, 7).join(" "), 80) || "New thread";
}
