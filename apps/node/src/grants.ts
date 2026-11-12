import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { newId, now } from "./util.js";

/**
 * Standing trust: what the owner already confirmed, so the same thing does not
 * come back as a card.
 *
 * A grant is a target and, when it carries content, that content. Confirming a
 * card for a message to a group writes two grants — the target (body empty) and
 * that message — so a different message to the same group still gets a look
 * unless the owner approved it in the conversation. Grants never expire and they
 * are not per thread: the owner trusts the agent, not one conversation. Deleting
 * one in Settings → Confirmations takes the trust back.
 *
 * Nothing here is decided by the model: a tool derives its own key from what it
 * really acts on (a window and the focused conversation, the recipients of the
 * mail), and the content by its own hashing, so a rewritten message never rides
 * on an older approval.
 */
export interface Grant {
  id: string;
  tool: string;
  key: string;
  label: string;
  /** Empty for the target itself; a digest of the outgoing content otherwise. */
  bodyHash: string;
  threadId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

interface GrantRow {
  id: string;
  tool: string;
  key: string;
  label: string;
  body_hash: string;
  thread_id: string | null;
  created_at: number;
  last_used_at: number | null;
}

function toGrant(r: GrantRow): Grant {
  return {
    id: r.id,
    tool: r.tool,
    key: r.key,
    label: r.label,
    bodyHash: r.body_hash,
    threadId: r.thread_id,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

/** A short digest of outgoing content, so any edit asks again. */
export function bodyDigest(body: string | undefined): string {
  if (!body) return "";
  return createHash("sha256").update(body.replace(/\s+/g, " ").trim()).digest("base64url").slice(0, 22);
}

export class Grants {
  constructor(private readonly db: Db) {}

  /** A grant for exactly this target and content (an empty hash asks for the target's own grant). */
  match(tool: string, key: string, bodyHash: string): Grant | undefined {
    const row = this.row(tool, key, bodyHash);
    return row ? this.touch(toGrant(row)) : undefined;
  }

  /** Whether the target itself is trusted, whatever the content is. */
  trusts(tool: string, key: string): boolean {
    return Boolean(this.row(tool, key, ""));
  }

  add(opts: { tool: string; key: string; label: string; bodyHash?: string; threadId?: string }): Grant {
    const bodyHash = opts.bodyHash ?? "";
    const existing = this.row(opts.tool, opts.key, bodyHash);
    if (existing) {
      this.db.run("UPDATE grants SET label = ? WHERE id = ?", opts.label, existing.id);
      return toGrant({ ...existing, label: opts.label });
    }
    const id = newId("grant");
    this.db.run(
      "INSERT INTO grants (id, tool, key, label, body_hash, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      opts.tool,
      opts.key,
      opts.label,
      bodyHash,
      opts.threadId ?? null,
      now(),
    );
    return this.get(id)!;
  }

  /** What the owner sees: the targets they trusted, newest first. */
  list(): Grant[] {
    return this.db.all<GrantRow>("SELECT * FROM grants ORDER BY created_at DESC").map(toGrant);
  }

  get(id: string): Grant | undefined {
    const r = this.db.get<GrantRow>("SELECT * FROM grants WHERE id = ?", id);
    return r ? toGrant(r) : undefined;
  }

  revoke(id: string): boolean {
    return this.db.run("DELETE FROM grants WHERE id = ?", id).changes > 0;
  }

  /** Forget what a tool learned about a target, e.g. when its window closed. */
  revokeKey(tool: string, key: string): number {
    return this.db.run("DELETE FROM grants WHERE tool = ? AND key = ?", tool, key).changes;
  }

  private row(tool: string, key: string, bodyHash: string): GrantRow | undefined {
    return this.db.get<GrantRow>("SELECT * FROM grants WHERE tool = ? AND key = ? AND body_hash = ?", tool, key, bodyHash);
  }

  private touch(grant: Grant): Grant {
    const at = now();
    this.db.run("UPDATE grants SET last_used_at = ? WHERE id = ?", at, grant.id);
    return { ...grant, lastUsedAt: at };
  }
}
