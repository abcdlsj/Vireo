/** Typed client for the current node's HTTP API. */

import type { FileInfo, NodeEvent } from "@vireo/protocol";
import { ApiError } from "./cloud";
import { authedUrl, currentNode, nodeAccess } from "./nodes";

export type * from "@vireo/protocol";
export { ApiError };

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const node = currentNode();
  if (!node) throw new ApiError("No node yet. Link one first.", 0);
  const access = await nodeAccess(retried);
  const headers: Record<string, string> = { authorization: `Bearer ${access.token}` };
  if (!(body instanceof FormData) && body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${access.baseUrl}${path}`, {
      method,
      headers,
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(`Can't reach ${node.name}.`, 0);
  }
  // A token can expire between fetching it and using it; get a new one once.
  if (res.status === 401 && !retried) return request(method, path, body, true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? res.statusText, res.status);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
  upload: (threadId: string, files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append("file", f);
    return request<{ files: FileInfo[] }>("POST", `/api/threads/${threadId}/files`, form);
  },
};

export type BusEvent = NodeEvent;

type Listener = (e: NodeEvent) => void;
const listeners = new Set<Listener>();
let stream: AbortController | undefined;
let watched = false;
let greeted = false;

/** A stream that lasted this long was healthy; anything shorter backs off. */
const HEALTHY_MS = 30_000;

/**
 * One shared stream of live updates from the node, held only while the page is
 * visible and something listens. Read with fetch rather than EventSource so
 * every reconnect sends a fresh token in a header.
 *
 * Why the tab matters: a stream left open costs a request every ping, and —
 * more to the point — it keeps the node's Durable Object awake for as long as
 * it is open, which is billed as compute duration. A hidden tab holding one
 * overnight burns roughly a free plan's whole daily allowance.
 */
export function onEvent(fn: Listener): () => void {
  listeners.add(fn);
  watchPage();
  startStream();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stopStream();
  };
}

/** Starts and stops the stream as the page is shown, hidden, frozen and restored. */
function watchPage(): void {
  if (watched) return;
  watched = true;
  const sync = () => (document.visibilityState === "hidden" ? stopStream() : startStream());
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("pagehide", stopStream);
  window.addEventListener("pageshow", startStream);
}

function startStream(): void {
  if (stream || listeners.size === 0 || document.visibilityState === "hidden") return;
  const ctl = new AbortController();
  stream = ctl;
  void follow(ctl.signal).finally(() => {
    if (stream === ctl) stream = undefined;
  });
}

function stopStream(): void {
  const ctl = stream;
  if (!ctl) return;
  stream = undefined;
  ctl.abort();
}

function emit(e: NodeEvent): void {
  for (const l of listeners) l(e);
}

async function follow(signal: AbortSignal): Promise<void> {
  let wait = 1000;
  while (!signal.aborted) {
    const began = Date.now();
    try {
      const access = await nodeAccess();
      const res = await fetch(`${access.baseUrl}/api/events`, { headers: { authorization: `Bearer ${access.token}`, accept: "text/event-stream" }, signal });
      if (res.status === 401) await nodeAccess(true);
      else if (res.ok && res.body) {
        await readEvents(res.body, (event, data) => {
          if (event === "ready") {
            // Everything open loads itself as the stream starts; only a gap may have missed something.
            if (greeted) emit({ type: "thread.updated", threadId: "*" });
            greeted = true;
          }
          else if (event === "message") emit(JSON.parse(data) as NodeEvent);
        });
      }
    } catch {
      // Dropped or unreachable: try again below.
    }
    if (signal.aborted) return;
    if (Date.now() - began > HEALTHY_MS) wait = 1000;
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 2, 15_000);
  }
}

/** Parses a server-sent event stream. */
async function readEvents(body: ReadableStream<Uint8Array>, on: (event: string, data: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, end);
      buf = buf.slice(end).replace(/^\r?\n\r?\n/, "");
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      on(event, data.join("\n"));
    }
  }
}

/** A file or image on the current node, loadable by the browser. */
export const fileUrl = (id: string) => authedUrl(`/api/files/${id}`);

export function closeEvents(): void {
  stream?.abort();
  stream = undefined;
}
