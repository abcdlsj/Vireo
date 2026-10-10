import type { Db } from "./db.js";
import { now, truncate } from "./util.js";
import type { Vault } from "./vault.js";

export type ToolCallStatus = "running" | "ok" | "error" | "awaiting_confirmation";

export interface ToolCallRecord {
  id: number;
  threadId: string;
  toolCallId: string | null;
  tool: string;
  agent: string | null;
  args: string;
  result: string | null;
  status: ToolCallStatus;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
}

interface Row {
  id: number;
  thread_id: string;
  tool_call_id: string | null;
  tool: string;
  agent: string | null;
  args: string;
  result: string | null;
  status: ToolCallStatus;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
}

/**
 * The per-thread record of every tool call, by the model or by the owner
 * through a confirmation card. Secrets are redacted before anything is
 * stored; results are stored as the owner reads them.
 */
export class Audit {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
  ) {}

  start(threadId: string, call: { tool: string; agent: string; args: unknown; toolCallId?: string }): number {
    return this.db.run(
      "INSERT INTO tool_calls (thread_id, tool_call_id, tool, agent, args, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
      threadId,
      call.toolCallId ?? null,
      call.tool,
      call.agent,
      this.vault.redact(JSON.stringify(call.args ?? {})),
      now(),
    ).lastInsertRowid;
  }

  end(id: number, status: ToolCallStatus, result: string): void {
    const started = this.db.get<{ started_at: number }>("SELECT started_at FROM tool_calls WHERE id = ?", id)?.started_at ?? now();
    this.db.run(
      "UPDATE tool_calls SET status = ?, result = ?, ended_at = ?, duration_ms = ? WHERE id = ?",
      status,
      this.vault.redact(truncate(result, 4000)),
      now(),
      now() - started,
      id,
    );
  }

  forThread(threadId: string): ToolCallRecord[] {
    return this.db.all<Row>("SELECT * FROM tool_calls WHERE thread_id = ? ORDER BY id", threadId).map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      toolCallId: r.tool_call_id,
      tool: r.tool,
      agent: r.agent,
      args: r.args,
      result: r.result,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationMs: r.duration_ms,
    }));
  }

  count(threadId: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tool_calls WHERE thread_id = ?", threadId)?.n ?? 0;
  }
}
