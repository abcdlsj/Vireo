import type { Bus } from "./bus.js";
import type { Db } from "./db.js";
import { newId, now, scoreText, searchTerms } from "./util.js";

/**
 * Long-term memory as a small temporal knowledge graph:
 *   entities  — the owner, people, places, projects…
 *   facts     — statements about an entity under a normalised key, each with
 *               a validity period. A newer fact with the same key replaces
 *               (invalidates) the older one instead of living alongside it.
 *   episodes  — what happened, with time and source, which facts trace to.
 *
 * The model mirrors Graphiti's bi-temporal design (valid_from / invalidated_at)
 * but runs inside SQLite so Vireo needs no extra services.
 */

export const OWNER_ENTITY_ID = "e_owner";

export interface Entity {
  id: string;
  name: string;
  kind: string;
  summary: string | null;
}

export interface Fact {
  id: string;
  entityId: string;
  entityName: string;
  key: string;
  statement: string;
  kind: "semantic" | "procedural";
  validFrom: number;
  validUntil: number | null;
  invalidatedAt: number | null;
  supersededBy: string | null;
  sourceThreadId: string | null;
  sourceThreadTitle: string | null;
  sourceEpisodeId: string | null;
  createdAt: number;
  updatedAt: number;
  current: boolean;
}

export interface NewFact {
  entity?: string;
  entityKind?: string;
  key?: string;
  statement: string;
  kind?: "semantic" | "procedural";
  validUntil?: number | null;
  sourceThreadId?: string | null;
  episodeId?: string | null;
}

interface FactRow {
  id: string;
  entity_id: string;
  entity_name: string;
  key: string;
  statement: string;
  kind: "semantic" | "procedural";
  valid_from: number;
  valid_until: number | null;
  invalidated_at: number | null;
  superseded_by: string | null;
  source_thread_id: string | null;
  source_thread_title: string | null;
  source_episode_id: string | null;
  created_at: number;
  updated_at: number;
}

const FACT_SELECT = `
  SELECT f.*, e.name AS entity_name, t.title AS source_thread_title
  FROM facts f
  JOIN entities e ON e.id = f.entity_id
  LEFT JOIN threads t ON t.id = f.source_thread_id`;

export function normaliseKey(key: string): string {
  return (
    key
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9.㐀-鿿]+/g, "_")
      .replace(/^_+|_+$/g, "") || "note"
  );
}

export class MemoryStore {
  constructor(
    private readonly db: Db,
    private readonly bus: Bus,
  ) {
    if (!this.db.get("SELECT id FROM entities WHERE id = ?", OWNER_ENTITY_ID)) {
      const t = now();
      this.db.run(
        "INSERT INTO entities (id, name, kind, summary, created_at, updated_at) VALUES (?, 'Owner', 'owner', 'The person Vireo works for', ?, ?)",
        OWNER_ENTITY_ID,
        t,
        t,
      );
    }
  }

  // ---- entities ----

  resolveEntity(name: string | undefined, kind = "thing"): Entity {
    const clean = (name ?? "").trim();
    if (!clean || /^(owner|me|myself|i|user|the owner|我|本人)$/i.test(clean)) return this.entity(OWNER_ENTITY_ID)!;
    const existing = this.db.get<Entity>("SELECT id, name, kind, summary FROM entities WHERE lower(name) = lower(?)", clean);
    if (existing) return existing;
    const id = newId("e");
    const t = now();
    this.db.run(
      "INSERT INTO entities (id, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      id,
      clean,
      kind || "thing",
      t,
      t,
    );
    return { id, name: clean, kind, summary: null };
  }

  entity(id: string): Entity | undefined {
    return this.db.get<Entity>("SELECT id, name, kind, summary FROM entities WHERE id = ?", id);
  }

  entities(): (Entity & { factCount: number })[] {
    return this.db.all<Entity & { factCount: number }>(
      `SELECT e.id, e.name, e.kind, e.summary,
        (SELECT COUNT(*) FROM facts f WHERE f.entity_id = e.id AND f.invalidated_at IS NULL) AS factCount
       FROM entities e ORDER BY e.kind = 'owner' DESC, e.name`,
    );
  }

  // ---- episodes ----

  addEpisode(opts: { threadId?: string | null; source: string; content: string; occurredAt?: number }): string {
    const id = newId("ep");
    this.db.run(
      "INSERT INTO episodes (id, thread_id, source, content, occurred_at) VALUES (?, ?, ?, ?, ?)",
      id,
      opts.threadId ?? null,
      opts.source,
      opts.content.slice(0, 8000),
      opts.occurredAt ?? now(),
    );
    return id;
  }

  episodes(opts: { threadId?: string; limit?: number; query?: string } = {}): { id: string; threadId: string | null; source: string; content: string; occurredAt: number }[] {
    const rows = this.db.all<{ id: string; thread_id: string | null; source: string; content: string; occurred_at: number }>(
      `SELECT * FROM episodes ${opts.threadId ? "WHERE thread_id = ?" : ""} ORDER BY occurred_at DESC LIMIT ?`,
      ...(opts.threadId ? [opts.threadId] : []),
      opts.query ? 500 : (opts.limit ?? 50),
    );
    let out = rows.map((r) => ({ id: r.id, threadId: r.thread_id, source: r.source, content: r.content, occurredAt: r.occurred_at }));
    if (opts.query) {
      const terms = searchTerms(opts.query);
      out = out.filter((e) => scoreText(terms, e.content) > 0).slice(0, opts.limit ?? 20);
    }
    return out;
  }

  // ---- facts ----

  /**
   * Records a fact. If a current fact with the same entity and key exists
   * and says something different, it is invalidated and superseded (M3).
   */
  addFact(input: NewFact): { fact: Fact; superseded: Fact[]; unchanged: boolean } {
    const entity = this.resolveEntity(input.entity, input.entityKind);
    const key = normaliseKey(input.key ?? input.statement.slice(0, 40));
    const t = now();
    const current = this.db.all<FactRow>(
      `${FACT_SELECT} WHERE f.entity_id = ? AND f.key = ? AND f.invalidated_at IS NULL`,
      entity.id,
      key,
    );
    const same = current.find((f) => f.statement.trim().toLowerCase() === input.statement.trim().toLowerCase());
    if (same) {
      this.db.run("UPDATE facts SET updated_at = ?, valid_until = COALESCE(?, valid_until) WHERE id = ?", t, input.validUntil ?? null, same.id);
      return { fact: this.fact(same.id)!, superseded: [], unchanged: true };
    }
    const id = newId("f");
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO facts (id, entity_id, key, statement, kind, valid_from, valid_until, source_thread_id, source_episode_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        entity.id,
        key,
        input.statement.trim(),
        input.kind ?? "semantic",
        t,
        input.validUntil ?? null,
        input.sourceThreadId ?? null,
        input.episodeId ?? null,
        t,
        t,
      );
      for (const old of current) {
        this.db.run("UPDATE facts SET invalidated_at = ?, superseded_by = ?, updated_at = ? WHERE id = ?", t, id, t, old.id);
      }
    });
    this.bus.publish({ type: "memory.updated" });
    return { fact: this.fact(id)!, superseded: current.map((r) => this.toFact(r)), unchanged: false };
  }

  fact(id: string): Fact | undefined {
    const row = this.db.get<FactRow>(`${FACT_SELECT} WHERE f.id = ?`, id);
    return row ? this.toFact(row) : undefined;
  }

  private toFact(r: FactRow): Fact {
    const t = now();
    return {
      id: r.id,
      entityId: r.entity_id,
      entityName: r.entity_name,
      key: r.key,
      statement: r.statement,
      kind: r.kind,
      validFrom: r.valid_from,
      validUntil: r.valid_until,
      invalidatedAt: r.invalidated_at,
      supersededBy: r.superseded_by,
      sourceThreadId: r.source_thread_id,
      sourceThreadTitle: r.source_thread_title,
      sourceEpisodeId: r.source_episode_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      current: r.invalidated_at === null && (r.valid_until === null || r.valid_until > t),
    };
  }

  /** All facts, optionally including replaced and expired ones (for review and history). */
  list(opts: { includeHistory?: boolean; entityId?: string; query?: string; limit?: number } = {}): Fact[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!opts.includeHistory) where.push("f.invalidated_at IS NULL");
    if (opts.entityId) {
      where.push("f.entity_id = ?");
      params.push(opts.entityId);
    }
    const rows = this.db.all<FactRow>(
      `${FACT_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY f.updated_at DESC`,
      ...params,
    );
    let facts = rows.map((r) => this.toFact(r));
    if (!opts.includeHistory) facts = facts.filter((f) => f.current);
    if (opts.query) {
      const terms = searchTerms(opts.query);
      facts = facts
        .map((f) => ({ f, s: scoreText(terms, `${f.entityName} ${f.key.replace(/[._]/g, " ")} ${f.statement}`) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.f);
    }
    return facts.slice(0, opts.limit ?? 500);
  }

  /** Facts that were true at a given moment (recall by time, M2). */
  asOf(time: number, query?: string): Fact[] {
    const rows = this.db.all<FactRow>(
      `${FACT_SELECT} WHERE f.valid_from <= ? AND (f.invalidated_at IS NULL OR f.invalidated_at > ?) AND (f.valid_until IS NULL OR f.valid_until > ?)`,
      time,
      time,
      time,
    );
    let facts = rows.map((r) => this.toFact(r));
    if (query) {
      const terms = searchTerms(query);
      facts = facts.filter((f) => scoreText(terms, `${f.entityName} ${f.key} ${f.statement}`) > 0);
    }
    return facts;
  }

  /** History of one slot: every version of the fact, newest first. */
  history(factId: string): Fact[] {
    const f = this.fact(factId);
    if (!f) return [];
    return this.db
      .all<FactRow>(`${FACT_SELECT} WHERE f.entity_id = ? AND f.key = ? ORDER BY f.created_at DESC`, f.entityId, f.key)
      .map((r) => this.toFact(r));
  }

  /** Owner correction: replaces the statement with a new version that supersedes the old one. */
  correct(factId: string, statement: string): Fact {
    const old = this.fact(factId);
    if (!old) throw new Error("Fact not found");
    const episodeId = this.addEpisode({ source: "owner_edit", content: `Owner corrected "${old.statement}" to "${statement}"` });
    const { fact } = this.addFact({
      entity: old.entityName,
      key: old.key,
      statement,
      kind: old.kind,
      validUntil: old.validUntil,
      sourceThreadId: old.sourceThreadId,
      episodeId,
    });
    return fact;
  }

  delete(factId: string): boolean {
    const r = this.db.run("DELETE FROM facts WHERE id = ?", factId);
    if (r.changes > 0) this.bus.publish({ type: "memory.updated" });
    return r.changes > 0;
  }

  deleteEntity(entityId: string): void {
    if (entityId === OWNER_ENTITY_ID) {
      this.db.run("DELETE FROM facts WHERE entity_id = ?", entityId);
    } else {
      this.db.run("DELETE FROM entities WHERE id = ?", entityId);
    }
    this.bus.publish({ type: "memory.updated" });
  }

  /** Everything derived from one thread (used when a thread is deleted or forgotten). */
  forgetThread(threadId: string): void {
    this.db.run("DELETE FROM facts WHERE source_thread_id = ?", threadId);
    this.db.run("DELETE FROM episodes WHERE thread_id = ?", threadId);
    this.bus.publish({ type: "memory.updated" });
  }

  /** Current facts about the owner, newest first (the always-on profile). */
  profile(limit = 30): Fact[] {
    return this.list({ entityId: OWNER_ENTITY_ID }).slice(0, limit);
  }

  /** Keys already used for an entity, so extraction can reuse them consistently. */
  keysFor(entityName?: string): string[] {
    const entity = entityName ? this.resolveEntity(entityName) : this.entity(OWNER_ENTITY_ID)!;
    return this.db
      .all<{ key: string }>("SELECT DISTINCT key FROM facts WHERE entity_id = ? AND invalidated_at IS NULL", entity.id)
      .map((r) => r.key);
  }
}
