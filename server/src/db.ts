import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";

/**
 * Thin wrapper over node:sqlite. SQLite keeps Vireo a single self-contained
 * process with zero external services; everything lives in one file.
 */
export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    migrate(this);
  }

  static open(dataDir: string): Db {
    return new Db(join(dataDir, "vireo.db"));
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  getKv<T>(key: string): T | undefined {
    const row = this.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key);
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setKv(key: string, value: unknown): void {
    this.run(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  deleteKv(key: string): void {
    this.run("DELETE FROM kv WHERE key = ?", key);
  }

  close(): void {
    this.raw.close();
  }
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    label TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',          -- active | done
    status_line TEXT NOT NULL DEFAULT '',
    agent TEXT NOT NULL DEFAULT 'triage',
    temporary INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    running INTEGER NOT NULL DEFAULT 0,
    needs_you INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    origin TEXT,                                    -- JSON: what opened the thread
    titled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_owner_at INTEGER,
    done_at INTEGER
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,             -- user | assistant | toolResult | notice
    agent TEXT,
    body TEXT NOT NULL,             -- JSON AgentMessage (or notice payload)
    llm INTEGER NOT NULL DEFAULT 1, -- whether the message is part of the model context
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_thread ON messages(thread_id, id);

  CREATE TABLE tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    tool_call_id TEXT,
    tool TEXT NOT NULL,
    agent TEXT,
    args TEXT NOT NULL,
    result TEXT,
    status TEXT NOT NULL,            -- running | ok | error | awaiting_confirmation | blocked
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER
  );
  CREATE INDEX tool_calls_thread ON tool_calls(thread_id, id);

  CREATE TABLE llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT,
    purpose TEXT NOT NULL,
    agent TEXT,
    provider TEXT,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX llm_calls_thread ON llm_calls(thread_id, id);

  CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,            -- pending | executing | done | failed | cancelled
    result TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX actions_thread ON actions(thread_id);

  CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'thing',  -- owner | person | place | project | org | thing
    summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX entities_name ON entities(lower(name));

  CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    thread_id TEXT,
    source TEXT NOT NULL,            -- message | thread_summary | owner_edit | tool
    content TEXT NOT NULL,
    occurred_at INTEGER NOT NULL
  );
  CREATE INDEX episodes_thread ON episodes(thread_id);

  CREATE TABLE facts (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    key TEXT NOT NULL,               -- normalised slot, e.g. "home_address" or "preference.airline"
    statement TEXT NOT NULL,         -- human readable fact
    kind TEXT NOT NULL DEFAULT 'semantic', -- semantic | procedural
    valid_from INTEGER NOT NULL,
    valid_until INTEGER,             -- natural expiry (e.g. trip date passed)
    invalidated_at INTEGER,          -- replaced by a newer fact
    superseded_by TEXT,
    source_thread_id TEXT,
    source_episode_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX facts_entity ON facts(entity_id, key);

  CREATE TABLE reminders (
    id TEXT PRIMARY KEY,
    thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,              -- reminder | follow_up
    text TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | fired | cancelled
    created_at INTEGER NOT NULL,
    fired_at INTEGER
  );

  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    origin TEXT NOT NULL,            -- upload | produced
    created_at INTEGER NOT NULL
  );

  CREATE TABLE related (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,              -- page | email | event | screenshot | file
    title TEXT NOT NULL,
    url TEXT,
    ref TEXT,
    data TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX related_thread ON related(thread_id);

  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    keys TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE procedures (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    steps TEXT NOT NULL,
    status TEXT NOT NULL,            -- proposed | approved | rejected
    source_thread_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE credentials (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    username TEXT NOT NULL,
    secret TEXT NOT NULL,            -- encrypted with the local vault key
    created_at INTEGER NOT NULL
  );

  CREATE TABLE local_events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    attendees TEXT NOT NULL DEFAULT '[]',
    location TEXT,
    description TEXT,
    created_at INTEGER NOT NULL
  );
  `,
  // Prompt-cache usage, for cost and cache-hit reporting.
  `
  ALTER TABLE llm_calls ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE llm_calls ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
  `,
  // Cards: the visible results of each matter (see cards/store.ts).
  `
  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,            -- working | needs_you | watching | ready | done
    data TEXT NOT NULL,              -- JSON, shaped by the kind (cards/kinds.ts)
    buttons TEXT NOT NULL DEFAULT '[]',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX cards_thread ON cards(thread_id);
  `,
  // What changed in a card's last update (see cards/diff.ts).
  `
  ALTER TABLE cards ADD COLUMN changes TEXT NOT NULL DEFAULT '[]';
  `,
];

function migrate(db: Db): void {
  db.raw.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.get<{ version: number }>("SELECT version FROM schema_version");
  let version = row?.version ?? 0;
  if (!row) db.run("INSERT INTO schema_version (version) VALUES (0)");
  while (version < MIGRATIONS.length) {
    db.tx(() => {
      db.raw.exec(MIGRATIONS[version]!);
      version += 1;
      db.run("UPDATE schema_version SET version = ?", version);
    });
  }
}
