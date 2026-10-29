import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { App } from "./app.js";
import { APPROVAL_TOOL } from "./tools/approval.js";
import { forModel } from "./tools/types.js";
import { errorMessage, newId, now, safeJson, truncate } from "./util.js";
import type { Action } from "@vireo/protocol";

export type { Action };

/**
 * How long an agent's approval waits for the owner. The agent stopped waiting long before (a hook
 * gives up after nine minutes), so past this the card only stands in the owner's way.
 */
export const APPROVAL_TTL_MS = 30 * 60_000;
export const NO_ANSWER = "no answer in time";


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
    result: r.result,
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
    this.app.bus.publish({ type: "action.updated", threadId, actionId: id });
    const thread = this.app.threads.get(threadId);
    void this.app.push.notify({
      title: thread ? `Confirm: ${thread.title}` : "Vireo needs your confirmation",
      body: summary,
      url: `/#thread/${threadId}`,
      tag: `action-${id}`,
      decide: { confirm: this.decisionUrl(id, "confirm"), cancel: this.decisionUrl(id, "cancel") },
    });
    return this.get(id)!;
  }

  /** The key that signs one-tap decision links; made once, kept in the database. */
  private decisionKey(): string {
    let key = this.app.db.getKv<string>("actions.decision_key");
    if (!key) {
      key = randomBytes(32).toString("base64url");
      this.app.db.setKv("actions.decision_key", key);
    }
    return key;
  }

  private signature(id: string, decision: "confirm" | "cancel"): string {
    return createHmac("sha256", this.decisionKey()).update(`${id}:${decision}`).digest("base64url");
  }

  /**
   * A link that confirms or declines one pending action with no sign-in, for
   * the buttons on a push notification. It is signed for that action and that
   * decision, and only reaches the owner inside their encrypted push.
   */
  decisionUrl(id: string, decision: "confirm" | "cancel"): string {
    return `${this.app.address.publicUrl().replace(/\/$/, "")}/public/decide/${id}/${decision}?sig=${this.signature(id, decision)}`;
  }

  verifyDecision(id: string, decision: string, sig: string | undefined): decision is "confirm" | "cancel" {
    if ((decision !== "confirm" && decision !== "cancel") || !sig) return false;
    const want = Buffer.from(this.signature(id, decision));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
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
      this.app.bus.publish({ type: "action.updated", threadId: a.threadId, actionId: id });
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
    const audit = this.app.audit.start(action.threadId, { tool: action.tool, agent: "owner", args });
    // What the model is told the call returned, framed as outside content when it is.
    let forAgent: string;
    try {
      const out = await tool.run(args as never, { app: this.app, thread, agent: "owner", confirmed: true });
      const clip = (v: string) => this.app.vault.redact(truncate(v, 4000));
      const display = out.display && { output: out.display.output && clip(out.display.output), note: out.display.note && clip(out.display.note) };
      this.setStatus(id, out.failed ? "failed" : "done", clip(out.text), display);
      this.app.audit.end(audit, out.failed ? "error" : "ok", out.text);
      forAgent = forModel(truncate(this.app.vault.redact(out.text), 3000), out.source);
    } catch (err) {
      forAgent = `Failed: ${this.app.vault.redact(errorMessage(err))}`;
      this.setStatus(id, "failed", forAgent);
      this.app.audit.end(audit, "error", forAgent);
    }
    this.app.threads.addNotice(
      action.threadId,
      "action_result",
      `The owner ${edited ? "edited and confirmed" : "confirmed"}: ${action.summary}${edited ? ` (final arguments: ${JSON.stringify(args)})` : ""}. Result: ${forAgent}\nContinue the task from here.`,
      { llm: true, data: { actionId: id } },
    );
    this.app.threads.update(action.threadId, { needs_you: 0 });
    if (!tool.settles) this.app.runner.schedule(action.threadId);
    return this.get(id)!;
  }

  cancel(id: string, reason?: string): Action {
    return this.close(id, (a) => `The owner cancelled: ${a.summary}${reason ? `. Reason: ${reason}` : ""}. Do not retry it unless the owner asks.`);
  }

  /** Agents' approvals still pending after APPROVAL_TTL_MS, cancelled for want of an answer. Returns how many. */
  expireApprovals(at = now()): number {
    const stale = this.app.db.all<{ id: string }>(
      "SELECT id FROM actions WHERE tool = ? AND status = 'pending' AND created_at <= ?",
      APPROVAL_TOOL,
      at - APPROVAL_TTL_MS,
    );
    for (const { id } of stale) this.close(id, (a) => `No answer in time: ${a.summary}. It was not approved.`, NO_ANSWER);
    return stale.length;
  }

  /** Cancels a pending action; `result` (shown on its card) says why when nobody decided. */
  private close(id: string, notice: (a: Action) => string, result?: string): Action {
    const claimed = this.app.db.run("UPDATE actions SET status = 'cancelled', result = ?, resolved_at = ? WHERE id = ? AND status = 'pending'", result ?? null, now(), id);
    const action = this.get(id);
    if (!action) throw new Error("Action not found");
    if (claimed.changes === 0) return action;
    this.app.bus.publish({ type: "action.updated", threadId: action.threadId, actionId: id });
    this.app.threads.addNotice(action.threadId, "action_result", notice(action), { llm: true, data: { actionId: id } });
    this.app.threads.update(action.threadId, { needs_you: 0 });
    if (!this.app.tools.get(action.tool)?.settles) this.app.runner.schedule(action.threadId);
    return action;
  }
}
