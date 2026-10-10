import type { App } from "./app.js";
import { bus } from "./bus.js";
import { stripUntrusted, type ToolOutput } from "./tools/types.js";
import { errorMessage, newId, now, safeJson, truncate } from "./util.js";

/**
 * Confirmation-gated actions (S1). When a model calls an outward-facing tool,
 * nothing happens: an action is stored, the thread moves to "Needs you" and
 * the owner is notified. The owner confirms (optionally after editing), edits
 * or cancels from any device; only then does Vireo run the tool itself and
 * resume the thread's work with the result. Pending actions survive restarts.
 */
export interface Action {
  id: string;
  threadId: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: "pending" | "executing" | "done" | "failed" | "cancelled";
  /** What the owner reads: the result with the model-facing wrapper taken off. */
  result: string | null;
  /** Raw output and a plain note, when the tool gave them (ToolOutput.display). */
  display: ToolOutput["display"] | null;
  createdAt: number;
  resolvedAt: number | null;
}

interface ActionRow {
  id: string;
  thread_id: string;
  tool: string;
  args: string;
  summary: string;
  status: Action["status"];
  result: string | null;
  display: string | null;
  created_at: number;
  resolved_at: number | null;
}

function toAction(r: ActionRow): Action {
  return {
    id: r.id,
    threadId: r.thread_id,
    tool: r.tool,
    args: safeJson(r.args, {}),
    summary: r.summary,
    status: r.status,
    result: r.result === null ? null : stripUntrusted(r.result),
    display: r.display ? safeJson(r.display, null) : null,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export class Actions {
  constructor(private readonly app: App) {
    // An action interrupted mid-execution is not retried automatically: it may
    // already have taken effect, so the owner decides.
    app.db.run("UPDATE actions SET status = 'failed', result = 'Interrupted by a restart; check whether it took effect before retrying.' WHERE status = 'executing'");
  }

  create(threadId: string, tool: string, args: Record<string, unknown>, summary: string): Action {
    const id = newId("act");
    this.app.db.run(
      "INSERT INTO actions (id, thread_id, tool, args, summary, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      id,
      threadId,
      tool,
      JSON.stringify(args),
      summary,
      now(),
    );
    this.app.threads.addNotice(threadId, "action", summary, { data: { actionId: id } });
    bus.publish({ type: "action.updated", threadId, actionId: id });
    const thread = this.app.threads.get(threadId);
    void this.app.push.notify({
      title: thread ? `Confirm: ${thread.title}` : "Vireo needs your confirmation",
      body: summary,
      url: `/#thread/${threadId}`,
      tag: `action-${id}`,
    });
    return this.get(id)!;
  }

  get(id: string): Action | undefined {
    const r = this.app.db.get<ActionRow>("SELECT * FROM actions WHERE id = ?", id);
    return r ? toAction(r) : undefined;
  }

  forThread(threadId: string): Action[] {
    return this.app.db.all<ActionRow>("SELECT * FROM actions WHERE thread_id = ? ORDER BY created_at", threadId).map(toAction);
  }

  pending(): Action[] {
    return this.app.db.all<ActionRow>("SELECT * FROM actions WHERE status = 'pending' ORDER BY created_at").map(toAction);
  }

  private setStatus(id: string, status: Action["status"], result?: string, display?: Action["display"]): void {
    this.app.db.run(
      "UPDATE actions SET status = ?, result = ?, display = ?, resolved_at = ? WHERE id = ?",
      status,
      result ?? null,
      display ? JSON.stringify(display) : null,
      now(),
      id,
    );
    const a = this.get(id);
    if (a) {
      bus.publish({ type: "action.updated", threadId: a.threadId, actionId: id });
      this.app.threads.changed(a.threadId);
    }
  }

  /** Runs the confirmed action and resumes the thread. */
  async confirm(id: string, editedArgs?: Record<string, unknown>): Promise<Action> {
    const claimed = this.app.db.run("UPDATE actions SET status = 'executing' WHERE id = ? AND status = 'pending'", id);
    const action = this.get(id);
    if (!action) throw new Error("Action not found");
    if (claimed.changes === 0) return action; // already handled on another device
    const tool = this.app.tools.get(action.tool);
    const thread = this.app.threads.get(action.threadId);
    if (!tool || !thread) {
      this.setStatus(id, "failed", "Tool or thread no longer exists");
      return this.get(id)!;
    }
    const args = editedArgs ? { ...action.args, ...editedArgs } : action.args;
    const edited = Boolean(editedArgs && JSON.stringify(args) !== JSON.stringify(action.args));
    if (edited) this.app.db.run("UPDATE actions SET args = ? WHERE id = ?", JSON.stringify(args), id);
    const started = now();
    const audit = this.app.db.run(
      "INSERT INTO tool_calls (thread_id, tool, agent, args, status, started_at) VALUES (?, ?, 'owner', ?, 'running', ?)",
      action.threadId,
      action.tool,
      this.app.vault.redact(JSON.stringify(args)),
      started,
    );
    let resultText: string;
    try {
      const out = await tool.run(args as never, { app: this.app, thread, agent: "owner", confirmed: true });
      resultText = out.text;
      const redact = (v: string | undefined) => (v === undefined ? undefined : this.app.vault.redact(truncate(v, 4000)));
      const display = out.display ? { output: redact(out.display.output), note: redact(out.display.note) } : undefined;
      this.setStatus(id, out.failed ? "failed" : "done", this.app.vault.redact(truncate(stripUntrusted(out.text), 4000)), display);
      this.app.db.run(
        "UPDATE tool_calls SET status = ?, result = ?, ended_at = ?, duration_ms = ? WHERE id = ?",
        out.failed ? "error" : "ok",
        this.app.vault.redact(truncate(out.text, 4000)),
        now(),
        now() - started,
        audit.lastInsertRowid,
      );
    } catch (err) {
      resultText = `Failed: ${errorMessage(err)}`;
      this.setStatus(id, "failed", resultText);
      this.app.db.run(
        "UPDATE tool_calls SET status = 'error', result = ?, ended_at = ?, duration_ms = ? WHERE id = ?",
        resultText,
        now(),
        now() - started,
        audit.lastInsertRowid,
      );
    }
    this.app.threads.addNotice(
      action.threadId,
      "action_result",
      `The owner ${edited ? "edited and confirmed" : "confirmed"}: ${action.summary}${edited ? ` (final arguments: ${JSON.stringify(args)})` : ""}. Result: ${truncate(this.app.vault.redact(resultText), 3000)}. Continue the task from here.`,
      { llm: true, data: { actionId: id } },
    );
    this.app.threads.update(action.threadId, { needs_you: 0 });
    this.app.runner.schedule(action.threadId);
    return this.get(id)!;
  }

  cancel(id: string, reason?: string): Action {
    const claimed = this.app.db.run("UPDATE actions SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status = 'pending'", now(), id);
    const action = this.get(id);
    if (!action) throw new Error("Action not found");
    if (claimed.changes === 0) return action;
    bus.publish({ type: "action.updated", threadId: action.threadId, actionId: id });
    this.app.threads.addNotice(
      action.threadId,
      "action_result",
      `The owner cancelled: ${action.summary}${reason ? `. Reason: ${reason}` : ""}. Do not retry it unless the owner asks.`,
      { llm: true, data: { actionId: id } },
    );
    this.app.threads.update(action.threadId, { needs_you: 0 });
    this.app.runner.schedule(action.threadId);
    return action;
  }
}
