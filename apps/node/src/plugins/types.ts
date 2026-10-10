import type { PluginField, PluginStatus } from "@vireo/protocol";
import type { Hono } from "hono";
import type { AgentDef } from "../agents.js";
import type { Actions } from "../actions.js";
import type { CalendarProvider, DriveProvider, MailProvider } from "../integrations/types.js";
import type { Notification } from "../push.js";
import type { SearchResult } from "../tools/research.js";
import type { ThreadStore } from "../threads.js";
import type { ToolDef } from "../tools/types.js";

export type { PluginStatus };
/** A setting on a plugin's form; secret values are encrypted at rest and never leave the node. */
export type ConfigField = Omit<PluginField, "set">;

/**
 * A plugin adds a capability Vireo does not need to start: its own tools,
 * optionally its own specialist agent, a settings form and a status. Plugins
 * ship with Vireo (the community catalog) and stay off until the owner adds
 * one in Settings → Plugins.
 */

export interface PluginAction {
  id: string;
  label: string;
  primary?: boolean;
}

export interface ActionResult {
  message?: string;
  /** The browser navigates here (OAuth). */
  redirect?: string;
}

/** What a request from the owner's browser tells a plugin. */
export interface RequestInfo {
  /** Public origin, used for OAuth redirect URIs. */
  origin: string;
  /** Origin of the Vireo app that made the request, to return to after OAuth. */
  appOrigin?: string;
}

/** Plugin-private state that survives restarts; keys never collide with other plugins. */
export interface PluginState {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

/**
 * What Vireo offers a plugin. Plugins get this narrow surface, not Vireo's
 * internals, so they stay replaceable and can later ship on their own.
 */
export interface PluginHost {
  /** Where browsers reach this node, for OAuth redirect URIs and webhooks. */
  publicUrl(req?: RequestInfo): string;
  /** This node's HTTP server on the loopback interface (e.g. for `tailscale serve`). */
  localUrl(): string;
  /** A plugin made this node reachable at a direct address (Tailscale), or no longer is. */
  setDirectUrl(url: string | undefined): void;
  /** Demo mode: in-memory calendar, mailbox and Drive instead of real accounts. */
  demo: boolean;
  threads: Pick<ThreadStore, "get" | "list" | "create">;
  /** Posts a message in a thread as the owner and gets Vireo working on it. */
  send(threadId: string, text: string): void;
  actions: Pick<Actions, "get" | "pending" | "confirm" | "cancel">;
  /** Called with what Vireo said whenever a run in any thread ends. */
  onRunFinished(fn: (threadId: string, text: string) => void): () => void;
  /** Scrubs every known secret from text leaving the node. */
  redact(text: string): string;
}

export interface PluginContext {
  id: string;
  /** Private directory under the data directory. */
  dir: string;
  /** Current settings with defaults applied and secrets decrypted. */
  config<T = Record<string, unknown>>(): T;
  /** Persists settings the plugin manages itself (e.g. migrated values). */
  setConfig(patch: Record<string, unknown>): void;
  /** Whether the owner has the plugin added right now. */
  enabled(): boolean;
  /** Tells Vireo the plugin's tools or agents changed (e.g. after connecting). */
  changed(): void;
  state: PluginState;
  host: PluginHost;
}

/** Accounts a plugin connects, used by the built-in calendar and email tools. */
export interface Providers {
  calendar?(): CalendarProvider | undefined;
  mail?(): MailProvider | undefined;
  drive?(): DriveProvider | undefined;
}

export interface PluginRuntime {
  tools: ToolDef[];
  /** Plugin tools offered to built-in agents, by agent name. */
  grants?: Record<string, string[]>;
  /** Specialists the plugin adds; triage and general can hand off to them. */
  agents?: AgentDef[];
  /** One line for triage describing when to route to the plugin's agent. */
  routing?: string;
  /** Called when the plugin is enabled, its settings change, or Vireo starts. */
  start?(): Promise<void>;
  stop?(): Promise<void>;
  status(req?: RequestInfo): Promise<PluginStatus>;
  actions?(): PluginAction[];
  runAction?(id: string, req: RequestInfo): Promise<ActionResult>;
  /** Routes under /public/ reachable without signing in (OAuth callbacks, webhooks); they must check their own state. */
  publicRoutes?(api: Hono): void;
  /** Plaintext secrets to scrub from tool output and logs. */
  secrets?(): string[];
  /** Called for every owner notification (reminders, confirmations, new mail). */
  notify?(n: Notification): void;
  /** Replaces the built-in web search; undefined means "not configured, use the built-in one". */
  search?(query: string, max: number): Promise<SearchResult[] | undefined>;
  /** Calendar, mail and Drive backed by the plugin's account. */
  providers?: Providers;
  /** Reads pages the built-in reader cannot (or every page, with always). */
  reader?(): { always: boolean; read(url: string): Promise<{ title: string; text: string; url: string }> } | undefined;
}

export interface PluginDef {
  id: string;
  name: string;
  description: string;
  author: string;
  homepage?: string;
  fields: ConfigField[];
  /**
   * Steps for setting the plugin up in Vireo's browser: the agent opens the
   * pages, the owner signs in by hand, and the agent creates keys and saves
   * them with plugin_save_from_page, so secrets never pass through the chat.
   */
  browserSetup?: string[];
  create(ctx: PluginContext): PluginRuntime;
}
