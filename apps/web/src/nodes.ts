/**
 * Nodes: each person runs their own Vireo node (`npx @abcdlsj/vireo-node`), with its
 * own threads, memory and plugins. The app talks to one node at a time, with
 * a short-lived token the cloud signs for it, through the cloud relay or
 * straight over the owner's tailnet.
 */

import type { NodeAccess, NodeSummary } from "@vireo/protocol";
import { cloud } from "./cloud";

const CURRENT = "vireo.node";
/** Refresh a token this long before it expires. */
const MARGIN = 60_000;

let list: NodeSummary[] = [];
let current: NodeSummary | undefined;
let access: NodeAccess | undefined;
let fetching: Promise<NodeAccess> | undefined;
let renew: number | undefined;

/** Loads the owner's nodes and picks the current one (the last used, else the first). */
export async function loadNodes(): Promise<NodeSummary[]> {
  list = await cloud.nodes();
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(CURRENT);
  } catch {
    // Storage blocked: use the first node.
  }
  const next = list.find((n) => n.id === saved) ?? list[0];
  if (next?.id !== current?.id) access = undefined;
  current = next;
  return list;
}

export function nodes(): NodeSummary[] {
  return list;
}

export function currentNode(): NodeSummary | undefined {
  return current;
}

/** Switches to another node, optionally opening a page there; the app reloads so nothing from the old one lingers. */
export function switchNode(id: string, hash = ""): void {
  try {
    localStorage.setItem(CURRENT, id);
  } catch {
    // Storage blocked: the switch lasts until reload.
  }
  location.hash = hash;
  location.reload();
}

/** One GET on a node other than the current one, with a token of its own; undefined when it can't be reached. */
export async function peekNode<T>(node: NodeSummary, path: string): Promise<T | undefined> {
  try {
    const a = await cloud.access(node.id);
    const res = await fetch(`${a.baseUrl}${path}`, { headers: { authorization: `Bearer ${a.token}` }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** A valid token for the current node, fetched or refreshed as needed. */
export async function nodeAccess(force = false): Promise<NodeAccess> {
  if (!current) throw new Error("No node yet");
  if (!force && access && access.expiresAt - MARGIN > Date.now()) return access;
  fetching ??= cloud.access(current.id).finally(() => (fetching = undefined));
  access = await fetching;
  // Keep a fresh token at hand for the URLs the browser loads itself.
  window.clearTimeout(renew);
  renew = window.setTimeout(() => void nodeAccess(true).catch(() => undefined), Math.max(access.expiresAt - MARGIN - Date.now(), 10_000));
  return access;
}

/**
 * A URL on the current node the browser loads itself (images, downloads),
 * carrying the token. Only valid once nodeAccess() has resolved, which it
 * has before anything renders.
 */
export function authedUrl(path: string): string {
  if (!access) return "";
  const url = `${access.baseUrl}${path}`;
  return `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(access.token)}`;
}
