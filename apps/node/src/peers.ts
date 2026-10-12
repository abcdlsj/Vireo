import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { NodePeers } from "@vireo/protocol";
import type { Identity } from "./identity.js";

/** Another node on the owner's account, and how to reach its MCP endpoint right now. */
export interface Peer {
  id: string;
  name: string;
  online: boolean;
  platform: string | null;
  /** The node's MCP endpoint, through the relay or on the tailnet. */
  url: string;
  token: string;
  expiresAt: number;
  createdAt: number;
}

/** How long a list of nodes is trusted before asking the cloud again. */
const FRESH = 5 * 60_000;

/**
 * The owner's other nodes. Every node of an account works for the same
 * person, so a node asks the cloud (proving itself with its secret) for the
 * others and a short-lived token for each: nothing needs pairing.
 */
export class Peers {
  private cached: { at: number; peers: Peer[]; selfCreatedAt?: number } | undefined;
  private fetching: Promise<Peer[]> | undefined;

  constructor(private readonly identity: Identity) {}

  /** The last list fetched, without waiting; empty until the first one. */
  known(): Peer[] {
    return this.cached?.peers ?? [];
  }

  /**
   * The node whose memory is the owner's one memory: the first node on the
   * account. Undefined when that is this node, or no other node is known.
   */
  async home(): Promise<Peer | undefined> {
    const peers = await this.list();
    const first = [...peers].sort((a, b) => a.createdAt - b.createdAt)[0];
    const mine = this.cached?.selfCreatedAt;
    if (!first || mine === undefined || mine <= first.createdAt) return undefined;
    return first;
  }

  /** One MCP tool call on another node; throws when it can't be reached or the call fails. */
  async call(peer: Peer, tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<string> {
    const client = new Client({ name: "vireo", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(peer.url), { requestInit: { headers: { authorization: `Bearer ${peer.token}` } } }));
      const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
      const out = ((r.content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("\n");
      if (r.isError) throw new Error(out);
      return out;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async list(force = false): Promise<Peer[]> {
    const c = this.cached;
    const soonest = Math.min(...(c?.peers.map((p) => p.expiresAt) ?? [Infinity]));
    if (!force && c && Date.now() - c.at < FRESH && soonest - Date.now() > 60_000) return c.peers;
    this.fetching ??= this.fetch().finally(() => (this.fetching = undefined));
    return this.fetching;
  }

  private async fetch(): Promise<Peer[]> {
    const id = this.identity.get();
    if (!id) return [];
    const res = await fetch(`${id.cloudUrl}/api/node/peers`, {
      method: "POST",
      headers: { authorization: `Bearer ${id.nodeId}:${id.nodeSecret}` },
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as NodePeers & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `The Vireo cloud answered ${res.status}`);
    const peers = data.peers.map(({ node, access }) => ({
      id: node.id,
      name: node.name,
      online: node.online || node.mode === "tailscale",
      platform: node.platform,
      url: `${access.baseUrl.replace(/\/$/, "")}/api/mcp`,
      token: access.token,
      expiresAt: access.expiresAt,
      createdAt: node.createdAt,
    }));
    this.cached = { at: Date.now(), peers, selfCreatedAt: data.self?.createdAt };
    return peers;
  }
}
