import type { LinkPoll, LinkRequest, LinkStart, LinkStartRequest, NodeAccess, NodeMode, NodeSummary, User } from "@vireo/protocol";
import type { Accounts } from "./accounts.js";
import type { CloudConfig } from "./config.js";
import type { Sql } from "./sql.js";
import type { SigningKey } from "./keys.js";
import { hash, newId, normalizeCode, now, secret, userCode } from "./util.js";

const LINK_TTL = 15 * 60_000;
const POLL_INTERVAL = 2;

interface NodeRow {
  id: string;
  owner_id: string;
  name: string;
  secret_hash: string;
  mode: NodeMode;
  direct_url: string | null;
  version: string | null;
  platform: string | null;
  created_at: number;
  last_seen_at: number | null;
}

interface LinkRow {
  user_code: string;
  device_hash: string;
  name: string;
  platform: string;
  version: string;
  mode: NodeMode;
  status: "pending" | "approved" | "denied" | "delivered";
  node_id: string | null;
  node_secret: string | null;
  expires_at: number;
}

export interface NodeRecord {
  id: string;
  ownerId: string;
  name: string;
  mode: NodeMode;
  directUrl: string | null;
}

/**
 * The nodes each account owns, and how a new node joins one: the node asks
 * for a code, the owner approves it in the app, and the node collects its
 * identity (id, secret, owner, the cloud's public key) by polling.
 */
export class Nodes {
  constructor(
    private readonly sql: Sql,
    private readonly config: CloudConfig,
    private readonly accounts: Accounts,
    private readonly key: SigningKey,
    /** Whether a node has its relay socket open right now. */
    private readonly online: (nodeId: string) => Promise<boolean>,
  ) {}

  private async summary(r: NodeRow): Promise<NodeSummary> {
    return {
      id: r.id,
      name: r.name,
      mode: r.mode,
      online: await this.online(r.id),
      directUrl: r.direct_url,
      version: r.version,
      platform: r.platform,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    };
  }

  async forUser(userId: string): Promise<NodeSummary[]> {
    const rows = await this.sql.all<NodeRow>("SELECT * FROM nodes WHERE owner_id = ? ORDER BY created_at", userId);
    return Promise.all(rows.map((r) => this.summary(r)));
  }

  /** A node the user may use; undefined for anyone else's. */
  async owned(userId: string, nodeId: string): Promise<NodeSummary | undefined> {
    const r = await this.sql.first<NodeRow>("SELECT * FROM nodes WHERE id = ? AND owner_id = ?", nodeId, userId);
    return r ? this.summary(r) : undefined;
  }

  async get(nodeId: string): Promise<NodeRecord | undefined> {
    const r = await this.sql.first<NodeRow>("SELECT * FROM nodes WHERE id = ?", nodeId);
    return r ? { id: r.id, ownerId: r.owner_id, name: r.name, mode: r.mode, directUrl: r.direct_url } : undefined;
  }

  async rename(userId: string, nodeId: string, name: string): Promise<boolean> {
    return (await this.sql.run("UPDATE nodes SET name = ? WHERE id = ? AND owner_id = ?", name.trim().slice(0, 60), nodeId, userId)) > 0;
  }

  async remove(userId: string, nodeId: string): Promise<boolean> {
    return (await this.sql.run("DELETE FROM nodes WHERE id = ? AND owner_id = ?", nodeId, userId)) > 0;
  }

  /** The node, if this is its secret; for the relay socket. */
  async authenticate(nodeId: string, nodeSecret: string): Promise<NodeRecord | undefined> {
    const r = await this.sql.first<NodeRow>("SELECT id FROM nodes WHERE id = ? AND secret_hash = ?", nodeId, await hash(nodeSecret));
    return r && this.get(r.id);
  }

  /** What a connected node reports about itself. */
  async seen(nodeId: string, info: { version?: string; platform?: string; mode?: NodeMode; directUrl?: string | null }): Promise<void> {
    const cur = await this.sql.first<NodeRow>("SELECT * FROM nodes WHERE id = ?", nodeId);
    if (!cur) return;
    await this.sql.run(
      "UPDATE nodes SET version = ?, platform = ?, mode = ?, direct_url = ?, last_seen_at = ? WHERE id = ?",
      info.version ?? cur.version,
      info.platform ?? cur.platform,
      info.mode ?? cur.mode,
      info.directUrl === undefined ? cur.direct_url : info.directUrl,
      now(),
      nodeId,
    );
  }

  /** A short-lived token for one node, and where the app should send it. */
  async access(user: User, nodeId: string): Promise<NodeAccess | undefined> {
    const node = await this.owned(user.id, nodeId);
    if (!node) return undefined;
    const iat = Math.floor(now() / 1000);
    const exp = iat + Math.floor(this.config.accessTtlMs / 1000);
    const token = await this.key.sign({ iss: this.config.publicUrl, sub: user.id, aud: node.id, login: user.login, role: "owner", iat, exp });
    const direct = node.mode === "tailscale" && node.directUrl;
    return { token, expiresAt: exp * 1000, baseUrl: direct ? node.directUrl! : this.relayUrl(node.id), mode: node.mode };
  }

  relayUrl(nodeId: string): string {
    return `${this.config.publicUrl}/n/${nodeId}`;
  }

  // ---- linking ----

  async startLink(req: LinkStartRequest): Promise<LinkStart> {
    await this.sql.run("DELETE FROM links WHERE expires_at < ?", now());
    const code = userCode();
    const deviceCode = secret();
    const expiresAt = now() + LINK_TTL;
    const mode: NodeMode = req.mode === "tailscale" ? "tailscale" : "relay";
    await this.sql.run(
      "INSERT INTO links (user_code, device_hash, name, platform, version, mode, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      code,
      await hash(deviceCode),
      (req.name || "My node").trim().slice(0, 60),
      String(req.platform ?? "").slice(0, 40),
      String(req.version ?? "").slice(0, 20),
      mode,
      expiresAt,
    );
    return { userCode: code, deviceCode, verifyUrl: `${this.config.webUrl}/#link=${code}`, interval: POLL_INTERVAL, expiresAt };
  }

  private async pendingLink(code: string): Promise<LinkRow | undefined> {
    const r = await this.sql.first<LinkRow>("SELECT * FROM links WHERE user_code = ?", normalizeCode(code));
    return r && r.status === "pending" && r.expires_at > now() ? r : undefined;
  }

  async linkRequest(code: string): Promise<LinkRequest | undefined> {
    const r = await this.pendingLink(code);
    return r && { userCode: r.user_code, name: r.name, platform: r.platform, mode: r.mode, expiresAt: r.expires_at };
  }

  /** The owner approves the node: it becomes theirs, under the name they chose. */
  async approve(user: User, code: string, name?: string): Promise<NodeSummary | undefined> {
    const r = await this.pendingLink(code);
    if (!r) return undefined;
    const id = newId("n");
    const nodeSecret = secret();
    await this.sql.run(
      "INSERT INTO nodes (id, owner_id, name, secret_hash, mode, version, platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      user.id,
      (name?.trim() || r.name).slice(0, 60),
      await hash(nodeSecret),
      r.mode,
      r.version,
      r.platform,
      now(),
    );
    await this.sql.run("UPDATE links SET status = 'approved', node_id = ?, node_secret = ? WHERE user_code = ?", id, nodeSecret, r.user_code);
    return this.owned(user.id, id);
  }

  async deny(code: string): Promise<boolean> {
    return (await this.sql.run("UPDATE links SET status = 'denied' WHERE user_code = ? AND status = 'pending'", normalizeCode(code))) > 0;
  }

  /** The node checks whether it was approved; the secret is handed over once. */
  async poll(deviceCode: string): Promise<LinkPoll> {
    const r = await this.sql.first<LinkRow>("SELECT * FROM links WHERE device_hash = ?", await hash(deviceCode));
    if (!r || r.status === "delivered") return { status: "expired" };
    if (r.status === "denied") return { status: "denied" };
    if (r.status === "pending") return r.expires_at > now() ? { status: "pending" } : { status: "expired" };
    const node = await this.get(r.node_id!);
    const owner = node && (await this.accounts.user(node.ownerId));
    await this.sql.run("UPDATE links SET status = 'delivered', node_secret = NULL WHERE user_code = ?", r.user_code);
    if (!node || !owner) return { status: "expired" };
    return { status: "approved", nodeId: node.id, nodeSecret: r.node_secret!, owner, publicKey: this.key.publicPem };
  }
}
