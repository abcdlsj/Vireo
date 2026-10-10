import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";
import type { Sql, SqlValue } from "../core/sql.js";

/** The cloud's database as a SQLite file, for the Node server. */
export class FileDb implements Sql {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(join(dataDir, "cloud.db"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  async all<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }

  async first<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
    return this.db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined;
  }

  async run(sql: string, ...params: SqlValue[]): Promise<number> {
    return Number(this.db.prepare(sql).run(...(params as SQLInputValue[])).changes);
  }

  close(): void {
    this.db.close();
  }
}
