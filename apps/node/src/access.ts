import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { NodeClaims } from "@vireo/protocol";
import type { NodeIdentity } from "./identity.js";

const HEADER = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
const keys = new Map<string, KeyObject>();

/**
 * Checks an access token from the app: signed by the cloud this node is
 * linked to, issued for this node, for its owner, and not expired. The same
 * check applies whether the request came through the relay or straight over
 * the tailnet, so the relay is never trusted to decide who gets in.
 */
export function verifyAccess(token: string | undefined, identity: NodeIdentity | undefined): NodeClaims | undefined {
  if (!token || !identity) return undefined;
  const [header, payload, sig] = token.split(".");
  if (header !== HEADER || !payload || !sig) return undefined;
  let key = keys.get(identity.publicKey);
  if (!key) {
    key = createPublicKey(identity.publicKey);
    keys.set(identity.publicKey, key);
  }
  if (!verify(null, Buffer.from(`${header}.${payload}`), key, Buffer.from(sig, "base64url"))) return undefined;
  let claims: NodeClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as NodeClaims;
  } catch {
    return undefined;
  }
  const ok = claims.aud === identity.nodeId && claims.sub === identity.owner.id && claims.exp * 1000 > Date.now();
  return ok ? claims : undefined;
}
