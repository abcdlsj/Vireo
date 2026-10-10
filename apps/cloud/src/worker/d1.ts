import type { Sql, SqlValue } from "../core/sql.js";

/** The cloud's database on Cloudflare D1. */
export class D1Sql implements Sql {
  constructor(private readonly db: D1Database) {}

  async all<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    return (await this.db.prepare(sql).bind(...params).all<T>()).results;
  }

  async first<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
    return (await this.db.prepare(sql).bind(...params).first<T>()) ?? undefined;
  }

  async run(sql: string, ...params: SqlValue[]): Promise<number> {
    return (await this.db.prepare(sql).bind(...params).run()).meta.changes;
  }
}
