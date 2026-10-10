import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    github_id INTEGER UNIQUE,
    login TEXT NOT NULL,
    name TEXT,
    avatar_url TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );

  -- App sign-ins; only a hash of each token is kept.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- In-flight sign-ins: the OAuth state, then the one-time code the app trades for a session.
  CREATE TABLE IF NOT EXISTS sign_ins (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,              -- state | code
    return_to TEXT,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    mode TEXT NOT NULL,              -- relay | tailscale
    direct_url TEXT,
    version TEXT,
    platform TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS nodes_owner ON nodes(owner_id);

  -- A node asking to be linked to an account (device authorization flow).
  CREATE TABLE IF NOT EXISTS links (
    user_code TEXT PRIMARY KEY,
    device_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    version TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,            -- pending | approved | denied | delivered
    node_id TEXT,
    node_secret TEXT,                -- held only until the node collects it
    expires_at INTEGER NOT NULL
  );
`;

/** The cloud's own SQLite database: accounts, nodes and in-flight sign-ins. */
export class Db {
  readonly raw: DatabaseSync;

  constructor(dataDir: string) {
    this.raw = new DatabaseSync(join(dataDir, "cloud.db"));
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.raw.exec(SCHEMA);
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.raw.prepare(sql).run(...params).changes);
  }

  close(): void {
    this.raw.close();
  }
}
