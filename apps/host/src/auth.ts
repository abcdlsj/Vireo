import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { now, sha256 } from "./util.js";

/**
 * Single-owner authentication (S7). The first visit sets a password; every
 * device then signs in with it and receives a long-lived session token,
 * sent as an HttpOnly cookie or as a Bearer token for API clients.
 *
 * Setup from a non-local address requires a one-time code printed in the
 * server log, so nobody else can claim a freshly started instance.
 */
export class Auth {
  readonly setupCode: string;

  constructor(
    private readonly db: Db,
    config: Config,
  ) {
    this.setupCode = String(randomInt(100000, 999999));
    if (config.ownerPassword && !this.hasOwner()) this.setPassword(config.ownerPassword);
  }

  hasOwner(): boolean {
    return Boolean(this.db.getKv("owner.password"));
  }

  setPassword(password: string): void {
    if (password.length < 6) throw new Error("Use at least 6 characters");
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    this.db.setKv("owner.password", { salt, hash });
  }

  verify(password: string): boolean {
    const stored = this.db.getKv<{ salt: string; hash: string }>("owner.password");
    if (!stored) return false;
    const hash = scryptSync(password, stored.salt, 64);
    return timingSafeEqual(hash, Buffer.from(stored.hash, "hex"));
  }

  createSession(label: string): string {
    const token = randomBytes(32).toString("base64url");
    const t = now();
    this.db.run("INSERT INTO sessions (token_hash, label, created_at, last_seen_at) VALUES (?, ?, ?, ?)", sha256(token), label.slice(0, 200), t, t);
    return token;
  }

  check(token: string | undefined): boolean {
    if (!token) return false;
    const h = sha256(token);
    const row = this.db.get<{ last_seen_at: number }>("SELECT last_seen_at FROM sessions WHERE token_hash = ?", h);
    if (!row) return false;
    if (now() - row.last_seen_at > 60_000) this.db.run("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?", now(), h);
    return true;
  }

  revoke(token: string): void {
    this.db.run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
  }

  sessions(): { label: string; createdAt: number; lastSeenAt: number }[] {
    return this.db
      .all<{ label: string; created_at: number; last_seen_at: number }>("SELECT label, created_at, last_seen_at FROM sessions ORDER BY last_seen_at DESC")
      .map((r) => ({ label: r.label, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
  }

  revokeAll(): void {
    this.db.run("DELETE FROM sessions");
  }
}
