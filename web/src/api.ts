/** Typed client for Vireo's HTTP API, talking to the current host. */

import type { Card } from "./cards/types";
import { authedUrl, currentHost, hostUrl } from "./hosts";

export interface Thread {
  id: string;
  title: string;
  state: "active" | "done";
  group: "overview" | "needs_you" | "in_progress" | "done";
  statusLine: string;
  agent: string;
  temporary: boolean;
  pinned: boolean;
  running: boolean;
  needsYou: boolean;
  pendingActions: number;
  summary: string | null;
  origin: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
}

export type Message =
  | { id: number; role: "user"; text: string; images: string[]; fromVireo: boolean; createdAt: number }
  | {
      id: number;
      role: "assistant";
      agent: string | null;
      text: string;
      thinking?: string;
      toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
      createdAt: number;
    }
  | { id: number; role: "tool"; toolCallId: string; toolName: string; isError: boolean; text: string; awaitingConfirmation?: string; createdAt: number }
  | { id: number; role: "notice"; kind: string; text: string; data: Record<string, unknown> | null; createdAt: number };

export interface Action {
  id: string;
  threadId: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: "pending" | "executing" | "done" | "failed" | "cancelled";
  result: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface Related {
  id: number;
  kind: string;
  title: string;
  url: string | null;
  ref: string | null;
  data: Record<string, unknown> | null;
  createdAt: number;
}

export interface FileInfo {
  id: string;
  threadId: string | null;
  name: string;
  mime: string;
  size: number;
  origin: "upload" | "produced";
  createdAt: number;
}

export interface Procedure {
  id: string;
  name: string;
  description: string;
  steps: string;
  status: "proposed" | "approved" | "rejected";
  source_thread_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ThreadDetail {
  thread: Thread;
  messages: Message[];
  actions: Action[];
  related: Related[];
  files: FileInfo[];
  procedures: Procedure[];
  cards: Card[];
}

export interface Fact {
  id: string;
  entityId: string;
  entityName: string;
  key: string;
  statement: string;
  kind: string;
  validFrom: number;
  validUntil: number | null;
  invalidatedAt: number | null;
  supersededBy: string | null;
  sourceThreadId: string | null;
  sourceThreadTitle: string | null;
  createdAt: number;
  updatedAt: number;
  current: boolean;
}

export interface ModelStatus {
  ready: boolean;
  fake: boolean;
  baseUrl: string;
  hasKey: boolean;
  source: { baseUrl: "settings" | "env" | "default"; apiKey: "settings" | "env" | "none" };
  api: "chat" | "responses";
  main?: string;
  fast?: string;
  choice: { main?: string; fast?: string };
  available: string[];
  error?: string;
}

export interface OwnerSettings {
  timezone: string;
  nudgeTime: string;
  workdayStart: string;
  workdayEnd: string;
  watchInbox: boolean;
  inboxQuery: string;
  watchCalendar: boolean;
  proxyUrl: string;
}

export interface Me {
  settings: OwnerSettings;
  models: ModelStatus;
  integrations: { calendar: string; mail: string | null; google: { installed: boolean; configured: boolean; connected: boolean; email?: string } };
  push: { publicKey: string; subscriptions: number };
  /** Every community plugin and whether Vireo can use it now. */
  capabilities: Capability[];
  testMode: boolean;
}

export interface Capability {
  id: string;
  name: string;
  description: string;
  state: "ready" | "needs_setup" | "not_added";
  message?: string;
}

export interface PluginField {
  key: string;
  label: string;
  type: "text" | "secret" | "boolean" | "select";
  options?: { value: string; label: string }[];
  default?: string | boolean;
  placeholder?: string;
  help?: string;
  multiline?: boolean;
  /** Secret fields: a value is stored. */
  set?: boolean;
}

export interface PluginView {
  id: string;
  name: string;
  description: string;
  author: string;
  homepage?: string;
  installed: boolean;
  fields: PluginField[];
  config: Record<string, unknown>;
  status?: { state: string; message: string; details?: { label: string; value: string }[]; link?: { label: string; href: string } };
  actions: { id: string; label: string; primary?: boolean }[];
  /** Vireo can set this plugin up in its browser while the owner signs in. */
  browserSetup: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const host = currentHost();
  if (!host) throw new ApiError("No host yet. Add one first.", 0);
  const headers: Record<string, string> = {};
  if (!(body instanceof FormData) && body !== undefined) headers["content-type"] = "application/json";
  if (host.token) headers.authorization = `Bearer ${host.token}`;
  let res: Response;
  try {
    res = await fetch(hostUrl(path, host), {
      method,
      credentials: host.url ? "omit" : "same-origin",
      headers,
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(`Can't reach ${host.name}.`, 0);
  }
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

export type BusEvent =
  | { type: "thread.updated"; threadId: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "message.created"; threadId: string; messageId: number }
  | { type: "message.delta"; threadId: string; streamId: string; delta: string; kind: "text" | "thinking" }
  | { type: "message.stream_start"; threadId: string; streamId: string; agent: string }
  | { type: "message.stream_end"; threadId: string; streamId: string }
  | { type: "step"; threadId: string; step: { tool: string; label: string; status: string; toolCallId?: string } }
  | { type: "action.updated"; threadId: string; actionId: string }
  | { type: "card.updated"; threadId: string; cardId: string }
  | { type: "memory.updated" }
  | { type: "procedure.updated" }
  | { type: "plugins.updated" };

type Listener = (e: BusEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | undefined;

/** One shared EventSource for live updates; reconnects automatically. */
export function onEvent(fn: Listener): () => void {
  listeners.add(fn);
  if (!source) {
    source = new EventSource(authedUrl("/api/events"));
    source.addEventListener("message", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data) as BusEvent;
      for (const l of listeners) l(e);
    });
    source.addEventListener("ready", () => {
      for (const l of listeners) l({ type: "thread.updated", threadId: "*" });
    });
  }
  return () => {
    listeners.delete(fn);
  };
}

/** A file or image on the current host, loadable by the browser. */
export const fileUrl = (id: string) => authedUrl(`/api/files/${id}`);

export function closeEvents(): void {
  source?.close();
  source = undefined;
}
