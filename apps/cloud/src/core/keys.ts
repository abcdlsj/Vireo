import type { NodeClaims } from "@vireo/protocol";
import type { Sql } from "./sql.js";
import { fromBase64Url, toBase64Url } from "./util.js";

const ALG = { name: "Ed25519" } as const;
const HEADER = toBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));

function pem(label: string, der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

function der(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
}

/**
 * The cloud's Ed25519 signing key. Nodes save the public half when they are
 * linked and verify every access token with it, so a token only works for
 * the node and the person it names. The key is made on first use and kept in
 * the cloud's database.
 */
export class SigningKey {
  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly publicKey: CryptoKey,
    /** SPKI PEM, as nodes store it. */
    readonly publicPem: string,
  ) {}

  static async load(sql: Sql): Promise<SigningKey> {
    let stored = (await sql.first<{ value: string }>("SELECT value FROM settings WHERE key = 'signing_key'"))?.value;
    if (!stored) {
      const pair = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
      const fresh = pem("PRIVATE KEY", (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
      // Two instances starting at once keep whichever key was stored first.
      await sql.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('signing_key', ?)", fresh);
      stored = (await sql.first<{ value: string }>("SELECT value FROM settings WHERE key = 'signing_key'"))!.value;
    }
    const privateKey = await crypto.subtle.importKey("pkcs8", der(stored), ALG, true, ["sign"]);
    // The public key is the private key's JWK without its private part.
    const { d: _d, key_ops: _ops, ...jwk } = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
    const publicKey = await crypto.subtle.importKey("jwk", jwk, ALG, true, ["verify"]);
    return new SigningKey(privateKey, publicKey, pem("PUBLIC KEY", (await crypto.subtle.exportKey("spki", publicKey)) as ArrayBuffer));
  }

  async sign(claims: NodeClaims): Promise<string> {
    const body = `${HEADER}.${toBase64Url(new TextEncoder().encode(JSON.stringify(claims)))}`;
    const sig = await crypto.subtle.sign(ALG, this.privateKey, new TextEncoder().encode(body));
    return `${body}.${toBase64Url(new Uint8Array(sig))}`;
  }

  /** The claims of a token this key signed and that has not expired, else undefined. */
  async verify(token: string): Promise<NodeClaims | undefined> {
    const [header, payload, sig] = token.split(".");
    if (header !== HEADER || !payload || !sig) return undefined;
    try {
      if (!(await crypto.subtle.verify(ALG, this.publicKey, fromBase64Url(sig), new TextEncoder().encode(`${header}.${payload}`)))) return undefined;
      const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as NodeClaims;
      return claims.exp * 1000 > Date.now() ? claims : undefined;
    } catch {
      return undefined;
    }
  }
}
