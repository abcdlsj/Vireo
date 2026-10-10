import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeClaims } from "@vireo/protocol";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const HEADER = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));

/**
 * The cloud's Ed25519 signing key. Nodes save the public half when they are
 * linked and verify every access token with it, so a token only works for
 * the node and the person it names.
 */
export class SigningKey {
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** SPKI PEM, as nodes store it. */
  readonly publicPem: string;

  constructor(dataDir: string) {
    const file = join(dataDir, "signing-key.pem");
    if (!existsSync(file)) {
      const { privateKey } = generateKeyPairSync("ed25519");
      writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    }
    this.privateKey = createPrivateKey(readFileSync(file));
    this.publicKey = createPublicKey(this.privateKey);
    this.publicPem = this.publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  sign(claims: NodeClaims): string {
    const body = `${HEADER}.${b64url(JSON.stringify(claims))}`;
    return `${body}.${b64url(sign(null, Buffer.from(body), this.privateKey))}`;
  }

  /** The claims of a token this key signed and that has not expired, else undefined. */
  verify(token: string): NodeClaims | undefined {
    const [header, payload, sig] = token.split(".");
    if (header !== HEADER || !payload || !sig) return undefined;
    if (!verify(null, Buffer.from(`${header}.${payload}`), this.publicKey, Buffer.from(sig, "base64url"))) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as NodeClaims;
      return claims.exp * 1000 > Date.now() ? claims : undefined;
    } catch {
      return undefined;
    }
  }
}
