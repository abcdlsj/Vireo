import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { newId, now } from "./util.js";

/**
 * Site credentials for browser work. Secrets are encrypted at rest with a key
 * kept next to the database, are never shown to a model, and are substituted
 * into the page only at the moment the browser types them (S4).
 */
export interface CredentialInfo {
  id: string;
  domain: string;
  username: string;
  createdAt: number;
}

export class Vault {
  private readonly key: Buffer;
  /** More secrets to scrub, e.g. plugin tokens. */
  extraSecrets: () => string[] = () => [];

  constructor(
    private readonly db: Db,
    dataDir: string,
  ) {
    const keyPath = join(dataDir, "vault.key");
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    this.key = readFileSync(keyPath);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
  }

  decrypt(blob: string): string {
    const buf = Buffer.from(blob, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  }

  list(): CredentialInfo[] {
    return this.db
      .all<{ id: string; domain: string; username: string; created_at: number }>("SELECT id, domain, username, created_at FROM credentials ORDER BY domain")
      .map((r) => ({ id: r.id, domain: r.domain, username: r.username, createdAt: r.created_at }));
  }

  add(domain: string, username: string, password: string): CredentialInfo {
    const id = newId("cred");
    const clean = normaliseDomain(domain);
    this.db.run(
      "INSERT INTO credentials (id, domain, username, secret, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      clean,
      username,
      this.encrypt(password),
      now(),
    );
    return { id, domain: clean, username, createdAt: now() };
  }

  remove(id: string): void {
    this.db.run("DELETE FROM credentials WHERE id = ?", id);
  }

  /** Looks up a credential for a host (exact domain or parent domain). */
  forHost(host: string): { username: string; password: string } | undefined {
    const h = normaliseDomain(host);
    const rows = this.db.all<{ domain: string; username: string; secret: string }>("SELECT domain, username, secret FROM credentials");
    const row = rows.find((r) => h === r.domain || h.endsWith(`.${r.domain}`));
    return row ? { username: row.username, password: this.decrypt(row.secret) } : undefined;
  }

  /** All plaintext secrets, used to scrub logs and tool output. */
  secrets(): string[] {
    const out: string[] = [];
    for (const r of this.db.all<{ secret: string }>("SELECT secret FROM credentials")) {
      try {
        out.push(this.decrypt(r.secret));
      } catch {
        // ignore undecryptable rows
      }
    }
    return [...out, ...this.extraSecrets()].filter((s) => s.length >= 4);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets()) out = out.split(s).join("[secret]");
    return out;
  }
}

export function normaliseDomain(input: string): string {
  let d = input.trim().toLowerCase();
  try {
    if (d.includes("://")) d = new URL(d).hostname;
  } catch {
    // fall through with the raw value
  }
  return d.replace(/^www\./, "").replace(/\/.*$/, "");
}
