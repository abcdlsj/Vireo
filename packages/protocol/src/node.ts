/**
 * What a node's HTTP API returns. The node builds these shapes and the app
 * reads them; both compile against this file.
 */

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
  | {
      id: number;
      role: "user";
      text: string;
      images: string[];
      /** Ids of the files the owner attached to this message. */
      fileIds: string[];
      fromVireo: boolean;
      createdAt: number;
    }
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

/** An outward-facing tool call waiting for, or decided by, the owner (S1). */
export interface Action {
  id: string;
  threadId: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: "pending" | "executing" | "done" | "failed" | "cancelled";
  /** The result as the owner reads it. */
  result: string | null;
  /** Raw output (shown like a terminal) and a plain note, when the tool gave them. */
  display: { output?: string; note?: string } | null;
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
  sourceThreadId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type CardStatus = "working" | "needs_you" | "watching" | "ready" | "done";

/** A button on a card: either sends a message to the card's thread as the owner, or opens a link. */
export interface CardButton {
  label: string;
  reply?: string;
  url?: string;
  primary?: boolean;
}

export interface CardChange {
  label: string;
  from: string;
  to: string;
}

/** The visible result of a matter; `data` is shaped by the kind. */
export interface Card {
  id: string;
  threadId: string;
  threadTitle: string;
  kind: string;
  title: string;
  status: CardStatus;
  data: Record<string, unknown>;
  buttons: CardButton[];
  /** The thread behind the card is working right now. */
  running: boolean;
  /** What the thread is doing right now, while it runs. */
  statusLine?: string;
  /** Facts the last update changed; empty for a new card or one that changed throughout. */
  changes: CardChange[];
  createdAt: number;
  updatedAt: number;
}

export interface ThreadDetail {
  thread: Thread;
  messages: Message[];
  actions: Action[];
  related: Related[];
  files: FileInfo[];
  procedures: Procedure[];
  cards: Card[];
  /**
   * When asked with ?from=N&sig=…, and the first N messages are still what
   * the caller has, `messages` holds only the ones after them and `from` is
   * N; otherwise `from` is 0 and `messages` is the whole conversation.
   */
  from?: number;
  /** A fingerprint of the conversation's older part, to send back as ?from=count&sig=value next time. */
  prefix?: { count: number; sig: string };
}

export interface ToolCallRecord {
  id: number;
  threadId: string;
  toolCallId: string | null;
  tool: string;
  agent: string | null;
  args: string;
  result: string | null;
  status: "running" | "ok" | "error" | "awaiting_confirmation";
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
}

export interface LlmCallRecord {
  id: number;
  threadId: string | null;
  purpose: string;
  agent: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  cost: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: number;
}

export interface ThreadAudit {
  toolCalls: ToolCallRecord[];
  llmCalls: LlmCallRecord[];
}

export interface ModelUsage {
  model: string;
  calls: number;
  /** Prompt tokens, cached ones included. */
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  cost: number | null;
}

export interface ThreadUsage {
  scope: "thread" | "all";
  models: ModelUsage[];
  context: { model: string; used: number; limit: number | null } | null;
}

export interface UsageByPurpose {
  purpose: string;
  provider: string | null;
  model: string | null;
  calls: number;
  input: number;
  output: number;
  cost: number;
  avgMs: number;
}

export interface Fact {
  id: string;
  entityId: string;
  entityName: string;
  key: string;
  statement: string;
  kind: "semantic" | "procedural";
  validFrom: number;
  validUntil: number | null;
  invalidatedAt: number | null;
  supersededBy: string | null;
  sourceThreadId: string | null;
  sourceThreadTitle: string | null;
  sourceEpisodeId: string | null;
  createdAt: number;
  updatedAt: number;
  current: boolean;
}

export interface Entity {
  id: string;
  name: string;
  kind: string;
  summary: string | null;
}

export interface Episode {
  id: string;
  threadId: string | null;
  source: string;
  content: string;
  occurredAt: number;
}

export interface MemoryView {
  facts: Fact[];
  entities: Entity[];
  episodes: Episode[];
}

export interface Reminder {
  id: string;
  threadId: string | null;
  kind: "reminder" | "follow_up";
  text: string;
  dueAt: number;
  createdAt: number;
}

/** Owner preferences that change Vireo's behaviour. */
export interface OwnerSettings {
  /** IANA time zone, detected from the owner's browser. */
  timezone: string;
  /** Local time of the daily "things need you" notification, "HH:MM". Empty disables it. */
  nudgeTime: string;
  /** Working hours used when looking for free slots. */
  workdayStart: string;
  workdayEnd: string;
  /** Check the inbox and open threads for mail that needs a reply. */
  watchInbox: boolean;
  /** Gmail search used to pick which mail to watch. */
  inboxQuery: string;
  /** Check the calendar for invitations and conflicts. */
  watchCalendar: boolean;
  /** HTTP proxy for web search, page fetches and the browser, e.g. "http://127.0.0.1:7890". Empty connects directly. */
  proxyUrl: string;
}

export type LlmApi = "chat" | "responses";

/** A coding-agent CLI on the node's machine that can serve as Vireo's model. */
export type CliId = "claude" | "codex" | "pi";

/**
 * Where Vireo's model comes from: an OpenAI-compatible endpoint, or a CLI on
 * the node's machine (and its sign-in). "auto" uses the endpoint when one is
 * set up, else the first CLI found.
 */
export type ModelProviderChoice = "auto" | "endpoint" | "cli";

export interface LocalCli {
  id: CliId;
  name: string;
  found: boolean;
  /** The executable Vireo runs. */
  path?: string;
  version?: string;
  /** Why it was not usable, when it was there but did not answer. */
  error?: string;
  /** The command that installs it. */
  install: string;
  /** What the owner runs once so the CLI is signed in. */
  signIn: string;
  /** Model names the CLI offers, for the pickers. */
  models: string[];
  /** What Vireo uses when the owner picks nothing. */
  defaults: { main: string; fast: string };
}

export interface ModelStatus {
  ready: boolean;
  fake: boolean;
  /** What the owner chose, and what is in use now. */
  provider: ModelProviderChoice;
  using: "endpoint" | "cli";
  /** The CLI in use (or chosen), when using is "cli". */
  cli?: CliId;
  /** Every supported CLI and whether it is on this machine. */
  clis: LocalCli[];
  baseUrl: string;
  hasKey: boolean;
  /** Where each value came from, for the settings page. */
  source: { baseUrl: "settings" | "env" | "default"; apiKey: "settings" | "env" | "none" };
  api: LlmApi;
  main?: string;
  fast?: string;
  /** Explicitly configured names (empty means automatic). */
  choice: { main?: string; fast?: string };
  available: string[];
  error?: string;
  /** Models chosen per CLI (empty means the CLI's default), and paths the owner set. */
  cliModels: Partial<Record<CliId, { main?: string; fast?: string }>>;
  cliPaths: Partial<Record<CliId, string>>;
}

/** What the assistant knows about one catalog plugin: whether it can use it now. */
export interface Capability {
  id: string;
  name: string;
  description: string;
  state: "ready" | "needs_setup" | "not_added";
  /** What is left to do, for a plugin that is added but not ready. */
  message?: string;
  /** Vireo can set this plugin up in its browser while the owner signs in. */
  browserSetup: boolean;
}

export interface PluginField {
  key: string;
  label: string;
  /** Secret values are encrypted at rest and never sent back to the browser or a model. */
  type: "text" | "secret" | "boolean" | "select" | "list";
  options?: { value: string; label: string }[];
  default?: string | boolean | PluginRow[];
  placeholder?: string;
  help?: string;
  /** Multi-line input (keys, certificates). */
  multiline?: boolean;
  /** Regular expression a valid value matches. */
  pattern?: string;
  /** Secret fields: a value is stored. */
  set?: boolean;
  /** A list's rows: their fields, in order. */
  items?: PluginField[];
}

/** One row of a list field. */
export type PluginRow = Record<string, unknown>;

export interface PluginStatus {
  state: "ready" | "setup" | "login" | "starting" | "error";
  message: string;
  details?: { label: string; value: string }[];
  /** A link the owner should open, e.g. a sign-in page. */
  link?: { label: string; href: string };
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
  status?: PluginStatus;
  actions: { id: string; label: string; primary?: boolean }[];
  /** Vireo can set this plugin up in its browser while the owner signs in. */
  browserSetup: boolean;
}

export interface Credential {
  id: string;
  domain: string;
  username: string;
}

/** Everything the app needs to know about the node on start. */
export interface Me {
  node: { id: string; name: string; version: string };
  settings: OwnerSettings;
  models: ModelStatus;
  integrations: { calendar: string; mail: string | null; drive: boolean };
  push: { publicKey: string; subscriptions: number };
  /** Every community plugin and whether Vireo can use it now. */
  capabilities: Capability[];
  testMode: boolean;
}
