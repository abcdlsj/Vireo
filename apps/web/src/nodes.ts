/**
 * Nodes: each person runs their own Vireo node (`npx @abcdlsj/vireo-node`), with its
 * own threads, memory and plugins. The app talks to one node at a time, with
 * a short-lived token the cloud signs for it, through the cloud relay or
 * straight over the owner's tailnet.
 */

import type { CSSProperties } from "react";
import type { NodeAccess, NodeSummary } from "@vireo/protocol";
import { cloud } from "./cloud";
import { cacheGet, cacheSet } from "./local-cache";

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
  cacheSet("nodes", list);
  pick();
  return list;
}

/**
 * The nodes as last loaded on this device, with the current one's token if
 * it is still good, so the app can open before the cloud answers. False when
 * there is nothing to go on.
 */
export function restoreNodes(): boolean {
  const saved = cacheGet<NodeSummary[]>("nodes");
  if (!saved?.length) return false;
  list = saved;
  pick();
  const kept = current && cacheGet<NodeAccess>(`access.${current.id}`);
  if (kept && kept.expiresAt - MARGIN > Date.now()) {
    access = kept;
    renewLater();
  }
  return Boolean(current);
}

function pick(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(CURRENT);
  } catch {
    // Storage blocked: use the first node.
  }
  const next = list.find((n) => n.id === saved) ?? list[0];
  if (next?.id !== current?.id) access = undefined;
  current = next;
  paint();
}

/** Hues closer than this are hard to tell apart in a faint tint. */
const APART = 40;
const GOLDEN = 137.508;
let hues = new Map<string, number>();

/**
 * Each node's own hue, so the owner tells nodes apart at a glance. It comes
 * from the node's id, so it stays the same everywhere and over time; a node
 * whose hue is too close to an older node's moves on until it stands apart.
 */
function assignHues(): void {
  hues = new Map();
  for (const n of [...list].sort((a, b) => a.createdAt - b.createdAt)) {
    let h = 2166136261;
    for (const c of n.id) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    let hue = (h % 3600) / 10;
    for (let i = 0; i < 8 && [...hues.values()].some((o) => Math.min(Math.abs(o - hue), 360 - Math.abs(o - hue)) < APART); i++) hue = (hue + GOLDEN) % 360;
    hues.set(n.id, Math.round(hue));
  }
}

/** The style that gives an element its node's tint (see .node-chip and .node-tint); nothing with a single node. */
export function nodeTint(id: string): CSSProperties | undefined {
  const hue = list.length > 1 ? hues.get(id) : undefined;
  return hue === undefined ? undefined : ({ "--hue": hue } as CSSProperties);
}

/** Washes the app in the current node's tint, once the owner has more than one. */
function paint(): void {
  assignHues();
  const root = document.documentElement;
  const hue = current && list.length > 1 ? hues.get(current.id) : undefined;
  root.classList.toggle("many-nodes", hue !== undefined);
  if (hue === undefined) root.style.removeProperty("--node-hue");
  else root.style.setProperty("--node-hue", String(hue));
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

/** One POST on a node other than the current one; throws with the node's own message when it refuses. */
export async function postNode<T>(node: NodeSummary, path: string, body: unknown = {}): Promise<T> {
  const a = await cloud.access(node.id);
  const res = await fetch(`${a.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${node.name} answered ${res.status}`);
  return data;
}

/** A valid token for the current node, fetched or refreshed as needed. */
export async function nodeAccess(force = false): Promise<NodeAccess> {
  if (!current) throw new Error("No node yet");
  if (!force && access && access.expiresAt - MARGIN > Date.now()) return access;
  fetching ??= cloud.access(current.id).finally(() => (fetching = undefined));
  access = await fetching;
  cacheSet(`access.${current.id}`, access);
  renewLater();
  return access;
}

/** Keeps a fresh token at hand for the URLs the browser loads itself. */
function renewLater(): void {
  if (!access) return;
  window.clearTimeout(renew);
  renew = window.setTimeout(() => void nodeAccess(true).catch(() => undefined), Math.max(access.expiresAt - MARGIN - Date.now(), 10_000));
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
