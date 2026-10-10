/** A SQL value both SQLite runtimes (node:sqlite and Cloudflare D1) accept. */
export type SqlValue = string | number | null;

/**
 * The cloud's database, as each runtime provides it: node:sqlite when it
 * runs as a Node server, D1 on Cloudflare. Both are SQLite.
 */
export interface Sql {
  all<T>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  first<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  /** Runs a statement; resolves with the number of rows it changed. */
  run(sql: string, ...params: SqlValue[]): Promise<number>;
}

/** Each statement separately, since D1 runs them one at a time. */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    github_id INTEGER UNIQUE,
    login TEXT NOT NULL,
    name TEXT,
    avatar_url TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  )`,
  // App sign-ins; only a hash of each token is kept.
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // In-flight sign-ins: the OAuth state, then the one-time code the app trades for a session.
  `CREATE TABLE IF NOT EXISTS sign_ins (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    return_to TEXT,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    mode TEXT NOT NULL,
    direct_url TEXT,
    version TEXT,
    platform TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS nodes_owner ON nodes(owner_id)`,
  // A node asking to be linked to an account (device authorization flow).
  `CREATE TABLE IF NOT EXISTS links (
    user_code TEXT PRIMARY KEY,
    device_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    version TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    node_id TEXT,
    node_secret TEXT,
    expires_at INTEGER NOT NULL
  )`,
  // The cloud's own settings, such as the key that signs node tokens.
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];
