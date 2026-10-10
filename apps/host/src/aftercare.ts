import type { App } from "./app.js";
import { messageText, OVERVIEW_ID } from "./threads.js";
import { now, truncate } from "./util.js";

/**
 * What follows a finished run: the thread's status line, "Needs you" when
 * Vireo ended on a question, a notification when the owner should know, and
 * memory upkeep. The runner only announces that a run ended.
 */
export class RunAftercare {
  constructor(private readonly app: App) {
    this.app.bus.subscribe((e) => {
      if (e.type === "run.finished") this.after(e.threadId, e.startedAt);
    });
  }

  private after(threadId: string, startedAt: number): void {
    const thread = this.app.threads.get(threadId);
    if (!thread) return;
    const last = this.app.threads
      .messages(threadId, { limit: 6 })
      .reverse()
      .find((m) => m.role === "assistant" && messageText(m.body));
    const text = last ? messageText(last.body) : "";
    const saidThisRun = Boolean(last && last.createdAt >= startedAt);

    const patch: Parameters<App["threads"]["update"]>[1] = {};
    // A status the agent set during this run wins over the first line of its reply.
    const statusSetAt = this.app.db.getKv<number>(`thread.status_set.${threadId}`) ?? 0;
    if (statusSetAt < startedAt) {
      const firstLine = text
        .replace(/[*_#>`]/g, "")
        .split(/\n|(?<=[.!?。！？])\s/)[0]
        ?.trim();
      patch.status_line = firstLine ? truncate(firstLine, 100) : thread.statusLine === "Working…" ? "" : thread.statusLine;
    }
    const asksOwner = saidThisRun && threadId !== OVERVIEW_ID && /[?？]\s*$/.test(text.trim());
    if (asksOwner) patch.needs_you = 1;
    this.app.threads.update(threadId, patch);

    const title = this.app.threads.get(threadId)!.title;
    const notify = { body: truncate(text, 140), url: `/#thread/${threadId}`, tag: threadId };
    if (asksOwner) void this.app.push.notify({ title, ...notify });
    else if (saidThisRun && now() - startedAt > 30_000) void this.app.push.notify({ title: `Done: ${title}`, ...notify });

    if (!thread.temporary) this.app.memoryWorker.afterRun(threadId);
  }
}
