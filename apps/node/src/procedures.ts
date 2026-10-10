import type { Procedure } from "@vireo/protocol";
import type { Bus } from "./bus.js";
import type { Db } from "./db.js";
import { newId, now } from "./util.js";

interface Row {
  id: string;
  name: string;
  description: string;
  steps: string;
  status: Procedure["status"];
  source_thread_id: string | null;
  created_at: number;
  updated_at: number;
}

const toProcedure = (r: Row): Procedure => ({
  id: r.id,
  name: r.name,
  description: r.description,
  steps: r.steps,
  status: r.status,
  sourceThreadId: r.source_thread_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** How recurring kinds of tasks are done for the owner; used only once the owner approves one. */
export class Procedures {
  constructor(
    private readonly db: Db,
    private readonly bus: Bus,
  ) {}

  list(): Procedure[] {
    return this.db.all<Row>("SELECT * FROM procedures ORDER BY updated_at DESC").map(toProcedure);
  }

  forThread(threadId: string): Procedure[] {
    return this.db.all<Row>("SELECT * FROM procedures WHERE source_thread_id = ?", threadId).map(toProcedure);
  }

  approved(): Procedure[] {
    return this.db.all<Row>("SELECT * FROM procedures WHERE status = 'approved'").map(toProcedure);
  }

  /** Proposed and approved ones, so a new proposal does not repeat them. */
  standing(): Procedure[] {
    return this.db.all<Row>("SELECT * FROM procedures WHERE status != 'rejected'").map(toProcedure);
  }

  propose(p: { name: string; description: string; steps: string; threadId: string | null }): string {
    const id = newId("proc");
    this.db.run(
      "INSERT INTO procedures (id, name, description, steps, status, source_thread_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?)",
      id,
      p.name,
      p.description,
      p.steps,
      p.threadId,
      now(),
      now(),
    );
    this.bus.publish({ type: "procedure.updated" });
    return id;
  }

  decide(id: string, status: "approved" | "rejected"): boolean {
    return this.changed(this.db.run("UPDATE procedures SET status = ?, updated_at = ? WHERE id = ?", status, now(), id).changes);
  }

  edit(id: string, patch: { name?: string; description?: string; steps?: string }): boolean {
    const cur = this.db.get<Row>("SELECT * FROM procedures WHERE id = ?", id);
    if (!cur) return false;
    return this.changed(
      this.db.run(
        "UPDATE procedures SET name = ?, description = ?, steps = ?, updated_at = ? WHERE id = ?",
        patch.name ?? cur.name,
        patch.description ?? cur.description,
        patch.steps ?? cur.steps,
        now(),
        id,
      ).changes,
    );
  }

  delete(id: string): boolean {
    return this.changed(this.db.run("DELETE FROM procedures WHERE id = ?", id).changes);
  }

  private changed(n: number): boolean {
    if (n > 0) this.bus.publish({ type: "procedure.updated" });
    return n > 0;
  }
}
