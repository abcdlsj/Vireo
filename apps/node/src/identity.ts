import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeMode, User } from "@vireo/protocol";

/** Who this node is and whom it belongs to, saved when the owner approves it in the app. */
export interface NodeIdentity {
  nodeId: string;
  cloudUrl: string;
  /** Proves this node to the cloud on the relay socket. */
  nodeSecret: string;
  owner: User;
  /** The cloud's Ed25519 public key (SPKI, PEM); every access token is checked against it. */
  publicKey: string;
  mode: NodeMode;
  linkedAt: number;
}

/** The identity file in the data directory; readable by its user only. */
export class Identity {
  private readonly file: string;
  private cached: NodeIdentity | undefined;

  constructor(dataDir: string) {
    this.file = join(dataDir, "node.json");
    if (existsSync(this.file)) this.cached = JSON.parse(readFileSync(this.file, "utf8")) as NodeIdentity;
  }

  get(): NodeIdentity | undefined {
    return this.cached;
  }

  save(identity: NodeIdentity): void {
    writeFileSync(this.file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.file, 0o600);
    this.cached = identity;
  }

  /** Forgets the link; the node must be linked again. */
  clear(): void {
    rmSync(this.file, { force: true });
    this.cached = undefined;
  }
}
