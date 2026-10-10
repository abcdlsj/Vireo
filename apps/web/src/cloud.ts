/**
 * The Vireo cloud: who is signed in (GitHub), the nodes they own, and
 * short-lived tokens to reach one. The app may be deployed apart from the
 * cloud (Vercel); VITE_VIREO_CLOUD names the cloud then, else it is this
 * origin.
 */

import type { CloudInfo, LinkRequest, NodeAccess, NodeSummary, User } from "@vireo/protocol";

export const CLOUD_URL = (import.meta.env.VITE_VIREO_CLOUD ?? "").replace(/\/+$/, "");

const SESSION = "vireo.session";
/** A node approval the owner opened before signing in; picked up after. */
const PENDING_LINK = "vireo.link";
/** Fired on window when the session ends (signed out here or rejected by the cloud). */
export const SIGNED_OUT = "vireo:signed-out";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the session lasts as long as the page.
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

let session = read(SESSION);

export function signedIn(): boolean {
  return Boolean(session);
}

function endSession(): void {
  session = null;
  store(SESSION, null);
  window.dispatchEvent(new Event(SIGNED_OUT));
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session) headers.authorization = `Bearer ${session}`;
  let res: Response;
  try {
    res = await fetch(`${CLOUD_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError("Can't reach Vireo. Check your connection.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401 && session) endSession();
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status);
  return data;
}

export const cloud = {
  info: () => call<CloudInfo>("GET", "/.well-known/vireo.json"),
  me: () => call<{ user: User }>("GET", "/api/me").then((r) => r.user),
  nodes: () => call<{ nodes: NodeSummary[] }>("GET", "/api/nodes").then((r) => r.nodes),
  renameNode: (id: string, name: string) => call<{ node: NodeSummary }>("PATCH", `/api/nodes/${id}`, { name }).then((r) => r.node),
  removeNode: (id: string) => call<{ ok: true }>("DELETE", `/api/nodes/${id}`),
  access: (id: string) => call<NodeAccess>("POST", `/api/nodes/${id}/token`, {}),
  linkRequest: (code: string) => call<{ request: LinkRequest }>("GET", `/api/link/${encodeURIComponent(code)}`).then((r) => r.request),
  approve: (code: string, name?: string) => call<{ node: NodeSummary }>("POST", `/api/link/${encodeURIComponent(code)}/approve`, { name }).then((r) => r.node),
  deny: (code: string) => call<{ ok: boolean }>("POST", `/api/link/${encodeURIComponent(code)}/deny`, {}),
};

/** Sends the browser to GitHub; it comes back to this app at #signed-in=CODE. */
export function signInWithGitHub(): void {
  location.href = `${CLOUD_URL}/auth/github?return_to=${encodeURIComponent(location.origin)}`;
}

/** For local development and tests, when the cloud allows it (VIREO_DEV_LOGIN). */
export async function devSignIn(login: string): Promise<void> {
  const r = await call<{ token: string }>("POST", "/api/auth/dev", { login });
  session = r.token;
  store(SESSION, r.token);
}

export async function signOut(): Promise<void> {
  await call("POST", "/api/auth/logout", {}).catch(() => undefined);
  endSession();
}

/**
 * Reads what the address says on start: a finished GitHub sign-in to
 * exchange for a session, a sign-in error, or a node to approve (kept until
 * the owner has signed in). Returns an error to show, if any.
 */
export async function takeSignIn(): Promise<string | undefined> {
  const params = new URLSearchParams(location.hash.slice(1));
  const link = params.get("link");
  if (link && !session) store(PENDING_LINK, link);
  const code = params.get("signed-in");
  const error = params.get("sign-in-error");
  if (!code && !error) return undefined;
  const pending = read(PENDING_LINK);
  store(PENDING_LINK, null);
  history.replaceState(null, "", `${location.pathname}${location.search}${pending ? `#link=${pending}` : ""}`);
  if (error) return error;
  try {
    const r = await call<{ token: string }>("POST", "/api/auth/exchange", { code });
    session = r.token;
    store(SESSION, r.token);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** After a dev sign-in, go to the node approval the owner opened first. */
export function resumePendingLink(): void {
  const pending = read(PENDING_LINK);
  if (!pending) return;
  store(PENDING_LINK, null);
  location.hash = `link=${pending}`;
}
