import type { Hono } from "hono";
import type { AgentDef } from "../agents.js";
import type { App } from "../app.js";
import type { ToolDef } from "../tools/types.js";

/**
 * A plugin adds a capability Vireo does not need to start: its own tools,
 * optionally its own specialist agent, a settings form and a status. Plugins
 * ship with Vireo (the community catalog) and stay off until the owner adds
 * one in Settings → Plugins.
 */

export interface ConfigField {
  key: string;
  label: string;
  /** Secret values are encrypted at rest and never sent back to the browser or a model. */
  type: "text" | "secret" | "boolean" | "select";
  options?: { value: string; label: string }[];
  default?: string | boolean;
  placeholder?: string;
  help?: string;
  /** Multi-line input (keys, certificates). */
  multiline?: boolean;
}

export interface PluginStatus {
  state: "ready" | "setup" | "login" | "starting" | "error";
  message: string;
  details?: { label: string; value: string }[];
  /** A link the owner should open, e.g. a sign-in page. */
  link?: { label: string; href: string };
}

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
}

export interface PluginContext {
  app: App;
  id: string;
  /** Private directory under the data directory. */
  dir: string;
  /** Current settings with defaults applied and secrets decrypted. */
  config<T = Record<string, unknown>>(): T;
  /** Persists settings the plugin manages itself (e.g. migrated values). */
  setConfig(patch: Record<string, unknown>): void;
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
  /** Routes reachable without signing in (OAuth callbacks); they must check their own state. */
  publicRoutes?(api: Hono): void;
  /** Plaintext secrets to scrub from tool output and logs. */
  secrets?(): string[];
}

export interface PluginDef {
  id: string;
  name: string;
  description: string;
  author: string;
  homepage?: string;
  fields: ConfigField[];
  create(ctx: PluginContext): PluginRuntime;
}
