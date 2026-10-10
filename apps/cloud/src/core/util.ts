/** Helpers on Web APIs only, so the same code runs on Node and on Cloudflare. */

export const now = () => Date.now();

function bytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toBase64Url(data: Uint8Array): string {
  let s = "";
  for (const b of data) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function newId(prefix: string): string {
  return `${prefix}_${toBase64Url(bytes(9))}`;
}

/** A random secret for tokens and codes the cloud stores only as a hash. */
export function secret(): string {
  return toBase64Url(bytes(32));
}

export async function hash(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A code a person reads and types: 8 unambiguous characters, shown as XXXX-XXXX. */
export function userCode(): string {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
  const chars = [...bytes(8)].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function normalizeCode(input: string): string {
  const c = input.toUpperCase().replace(/[^A-Z]/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
