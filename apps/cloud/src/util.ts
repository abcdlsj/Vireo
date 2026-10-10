import { createHash, randomBytes } from "node:crypto";

export const now = () => Date.now();

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

/** A random secret for tokens and codes the cloud stores only as a hash. */
export function secret(): string {
  return randomBytes(32).toString("base64url");
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A code a person reads and types: 8 unambiguous characters, shown as XXXX-XXXX. */
export function userCode(): string {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function normalizeCode(input: string): string {
  const c = input.toUpperCase().replace(/[^A-Z]/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
