import { randomInt, timingSafeEqual } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { now, sha256 } from "./util.js";

/**
 * Pairing lets a Vireo app on another device or origin connect to this host
 * without the owner's password: the host hands out a short one-time code
 * (in its log, from `npm run pair`, or from an already paired device), and
 * the app trades it for a session token.
 */

const KEY = "pairing.codes";
/** No 0/O, 1/I/L: codes are read off a terminal and typed on a phone. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const PAIRING_TTL_MS = 15 * 60_000;

interface StoredCode {
  hash: string;
  expiresAt: number;
}

/** Uppercases and drops separators, so "k7qm-2xpa" and "K7QM 2XPA" match. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export class Pairing {
  constructor(private readonly db: Db) {}

  private live(): StoredCode[] {
    const t = now();
    return (this.db.getKv<StoredCode[]>(KEY) ?? []).filter((c) => c.expiresAt > t);
  }

  /** A fresh single-use code, e.g. "K7QM-2XPA" (40 bits), valid for 15 minutes. */
  create(ttlMs = PAIRING_TTL_MS): { code: string; expiresAt: number } {
    let code = "";
    for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    const expiresAt = now() + ttlMs;
    this.db.setKv(KEY, [...this.live(), { hash: sha256(code), expiresAt }].slice(-20));
    return { code: formatCode(code), expiresAt };
  }

  /** Consumes the code if it is valid. */
  redeem(code: string): boolean {
    const want = Buffer.from(sha256(normalizeCode(code)), "hex");
    const codes = this.live();
    const i = codes.findIndex((c) => timingSafeEqual(Buffer.from(c.hash, "hex"), want));
    if (i < 0) {
      this.db.setKv(KEY, codes);
      return false;
    }
    codes.splice(i, 1);
    this.db.setKv(KEY, codes);
    return true;
  }
}

/** The name devices show for this host. */
export function hostName(config: Config): string {
  return config.hostName || hostname().replace(/\.local$/, "") || "Vireo";
}

/** Addresses another device could use to reach this host. */
export function hostUrls(config: Config): string[] {
  if (config.publicUrl) return [config.publicUrl];
  const urls: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) urls.push(`http://${a.address}:${config.port}`);
    }
  }
  return urls.length ? urls : [`http://localhost:${config.port}`];
}

/** The lines printed for the owner when a code is issued. */
export function pairingInstructions(config: Config, code: string): string[] {
  const urls = hostUrls(config);
  return [
    `  Pair a device with this host (code valid for 15 minutes, single use):`,
    `    Code: ${code}`,
    ...(config.appUrl ? [`    Open: ${config.appUrl}/#pair=${normalizeCode(code)}&host=${encodeURIComponent(urls[0]!)}`] : []),
    `    In Vireo, choose Hosts → Add host and paste: ${urls[0]}#pair=${normalizeCode(code)}`,
    ...(urls.length > 1 ? [`    Other addresses: ${urls.slice(1).join(", ")}`] : []),
    `    New code: npm run pair (Docker: docker compose exec host npm run pair)`,
  ];
}
