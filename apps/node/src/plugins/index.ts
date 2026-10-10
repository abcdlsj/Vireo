import type { Capability, PluginView } from "@vireo/protocol";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { AgentDef } from "../agents.js";
import type { App } from "../app.js";
import type { Notification } from "../push.js";
import type { ToolDef } from "../tools/types.js";
import { errorMessage, now } from "../util.js";
import type { SearchResult } from "../tools/research.js";
import { feishuPlugin } from "./feishu/index.js";
import { googlePlugin } from "./google/index.js";
import { mcpPlugin } from "./mcp/index.js";
import { searchPlugin } from "./search/index.js";
import { tailscalePlugin } from "./tailscale/index.js";
import { telegramPlugin } from "./telegram/index.js";
import type { ActionResult, PluginDef, PluginHost, PluginRuntime, PluginState, PluginStatus, Providers, RequestInfo } from "./types.js";

export * from "./types.js";

/** The community catalog: every plugin that ships with Vireo. */
export const CATALOG: PluginDef[] = [googlePlugin, tailscalePlugin, telegramPlugin, feishuPlugin, mcpPlugin, searchPlugin];

interface Stored {
  enabled: boolean;
  /** Plain values; secret fields are stored as vault ciphertext under "enc:<key>". */
  config: Record<string, unknown>;
}

/** A thread that asked for something a plugin would make possible, waiting for it to be ready. */
interface SetupWait {
  threadId: string;
  plugin: string;
  at: number;
}

const KEY = "plugins";
const WAITS = "plugins.setup_waits";
/** Statuses older than this are refreshed in the background when read. */
const STATUS_TTL = 30_000;
/** A thread stops waiting on a setup after a week. */
const WAIT_TTL = 7 * 864e5;

/** Installs, configures and runs plugins; installed plugins survive restarts. */
export class Plugins {
  private readonly runtimes = new Map<string, PluginRuntime>();
  /** Last known status of each installed plugin, so a prompt can say what is ready without waiting on it. */
  private readonly statuses = new Map<string, PluginStatus>();
  private checkedAt = 0;
  private refreshing: Promise<void> | undefined;
  private again: Promise<void> | undefined;

  constructor(private readonly app: App) {
    const host: PluginHost = {
      publicUrl: (req) => app.address.publicUrl(req),
      localUrl: () => app.address.localUrl(),
      setDirectUrl: (url) => app.address.setDirectUrl(url),
      demo: app.config.fakeGoogle,
      threads: app.threads,
      send: (threadId, text) => void app.runner.send(threadId, text),
      // Actions are wired after plugins; read them when a plugin uses them.
      get actions() {
        return app.actions;
      },
      onRunFinished: (fn) => app.bus.subscribe((e) => e.type === "run.finished" && fn(e.threadId, e.text)),
      redact: (text) => app.vault.redact(text),
    };
    for (const def of CATALOG) {
      const dir = join(app.config.dataDir, "plugins", def.id);
      this.runtimes.set(
        def.id,
        def.create({
          id: def.id,
          dir,
          config: <T>() => this.config(def.id) as T,
          setConfig: (patch) => this.write(def.id, patch),
          enabled: () => this.installed(def.id),
          changed: () => this.changed(),
          state: this.stateOf(def.id),
          host,
        }),
      );
    }
  }

  /** Each plugin's private state lives under its own key prefix. */
  private stateOf(id: string): PluginState {
    const key = (k: string) => `plugin.${id}.${k}`;
    return {
      get: <T>(k: string) => this.app.db.getKv<T>(key(k)),
      set: (k, v) => this.app.db.setKv(key(k), v),
      delete: (k) => this.app.db.deleteKv(key(k)),
    };
  }

  private all(): Record<string, Stored> {
    return this.app.db.getKv<Record<string, Stored>>(KEY) ?? {};
  }

  private def(id: string): PluginDef {
    const def = CATALOG.find((d) => d.id === id);
    if (!def) throw new Error(`Unknown plugin: ${id}`);
    return def;
  }

  installed(id: string): boolean {
    return Boolean(this.all()[id]?.enabled);
  }

  runtime(id: string): PluginRuntime | undefined {
    return this.installed(id) ? this.runtimes.get(id) : undefined;
  }

  /** Settings with defaults applied and secrets decrypted. */
  config(id: string): Record<string, unknown> {
    const def = this.def(id);
    const stored = this.all()[id]?.config ?? {};
    const out: Record<string, unknown> = {};
    for (const f of def.fields) {
      if (f.type === "secret") {
        const enc = stored[`enc:${f.key}`];
        out[f.key] = typeof enc === "string" ? this.app.vault.decrypt(enc) : "";
      } else {
        out[f.key] = stored[f.key] ?? f.default ?? (f.type === "boolean" ? false : "");
      }
    }
    return out;
  }

  /** Merges a patch. Secret fields: omitted keeps the stored value, "" clears it. */
  private write(id: string, patch: Record<string, unknown>, enabled?: boolean): void {
    const def = this.def(id);
    const all = this.all();
    const cur: Stored = all[id] ?? { enabled: false, config: {} };
    const config = { ...cur.config };
    for (const f of def.fields) {
      if (!(f.key in patch)) continue;
      const v = patch[f.key];
      if (f.type === "secret") {
        if (v === "" || v == null) delete config[`enc:${f.key}`];
        else config[`enc:${f.key}`] = this.app.vault.encrypt(String(v).trim());
      } else if (f.type === "boolean") {
        config[f.key] = Boolean(v);
      } else {
        config[f.key] = typeof v === "string" ? v.trim() : v;
      }
    }
    all[id] = { enabled: enabled ?? cur.enabled, config };
    this.app.db.setKv(KEY, all);
  }

  /** Starts every installed plugin; failures are reported in its status, not thrown. */
  async start(): Promise<void> {
    for (const def of CATALOG) if (this.installed(def.id)) await this.startOne(def.id);
    await this.refreshStatuses();
  }

  private async startOne(id: string): Promise<void> {
    mkdirSync(join(this.app.config.dataDir, "plugins", id), { recursive: true });
    try {
      await this.runtimes.get(id)!.start?.();
    } catch (err) {
      console.warn(`[plugin:${id}] start failed: ${errorMessage(err)}`);
    }
  }

  async stop(): Promise<void> {
    for (const r of this.runtimes.values()) await r.stop?.().catch(() => undefined);
  }

  async install(id: string, config: Record<string, unknown> = {}): Promise<void> {
    this.write(id, config, true);
    this.changed();
    await this.startOne(id);
    await this.refreshStatuses();
  }

  async uninstall(id: string): Promise<void> {
    this.def(id);
    await this.runtimes.get(id)?.stop?.().catch(() => undefined);
    const all = this.all();
    delete all[id];
    this.app.db.setKv(KEY, all);
    this.statuses.delete(id);
    this.changed();
  }

  async configure(id: string, patch: Record<string, unknown>): Promise<void> {
    if (!this.installed(id)) throw new Error("Add the plugin first.");
    this.write(id, patch);
    await this.runtimes.get(id)?.stop?.().catch(() => undefined);
    await this.startOne(id);
    this.changed();
    await this.refreshStatuses();
  }

  async action(id: string, actionId: string, req: RequestInfo): Promise<ActionResult> {
    const r = this.runtime(id);
    if (!r?.runAction) throw new Error("This plugin has no actions.");
    const out = await r.runAction(actionId, req);
    this.changed();
    await this.refreshStatuses();
    return out;
  }

  private changed(): void {
    this.app.tools = this.app.buildTools();
    this.app.bus.publish({ type: "plugins.updated" });
  }

  async list(req: RequestInfo): Promise<PluginView[]> {
    return Promise.all(CATALOG.map((def) => this.view(def, req)));
  }

  private async view(def: PluginDef, req: RequestInfo): Promise<PluginView> {
    const installed = this.installed(def.id);
    const config = installed ? this.config(def.id) : {};
    const runtime = this.runtimes.get(def.id)!;
    let status: PluginStatus | undefined;
    if (installed) {
      try {
        status = await runtime.status(req);
      } catch (err) {
        status = { state: "error", message: errorMessage(err) };
      }
      this.noteStatus(def.id, status);
    }
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      author: def.author,
      homepage: def.homepage,
      installed,
      fields: def.fields.map((f) => (f.type === "secret" ? { ...f, set: Boolean(config[f.key]) } : f)),
      // Secrets never leave the server.
      config: Object.fromEntries(Object.entries(config).filter(([k]) => def.fields.find((f) => f.key === k)?.type !== "secret")),
      status,
      actions: installed ? (runtime.actions?.() ?? []) : [],
      browserSetup: Boolean(def.browserSetup?.length),
    };
  }

  /**
   * Asks every installed plugin for its status. One refresh runs at a time; a
   * call during one runs again after it, so a change just made is always seen.
   */
  refreshStatuses(): Promise<void> {
    if (this.refreshing) {
      this.again ??= this.refreshing.then(() => {
        this.again = undefined;
        return this.refreshStatuses();
      });
      return this.again;
    }
    const run = (async () => {
      for (const def of CATALOG) {
        if (!this.installed(def.id)) {
          this.statuses.delete(def.id);
          continue;
        }
        let st: PluginStatus;
        try {
          st = await this.runtimes.get(def.id)!.status();
        } catch (err) {
          st = { state: "error", message: errorMessage(err) };
        }
        this.noteStatus(def.id, st);
      }
      this.checkedAt = now();
    })();
    // Cleared once settled (not inside the run, which may finish before it is assigned).
    this.refreshing = run.finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private noteStatus(id: string, status: PluginStatus): void {
    const was = this.statuses.get(id)?.state;
    this.statuses.set(id, status);
    if (status.state === "ready" && was !== "ready") this.resumeWaiting(id);
  }

  /**
   * Every catalog plugin and whether the assistant can use it now, from the
   * last known statuses (refreshed in the background when stale).
   */
  capabilities(): Capability[] {
    if (now() - this.checkedAt > STATUS_TTL) void this.refreshStatuses();
    return CATALOG.map((def) => {
      const base = { id: def.id, name: def.name, description: def.description, browserSetup: Boolean(def.browserSetup?.length) };
      if (!this.installed(def.id)) return { ...base, state: "not_added" as const };
      const st = this.statuses.get(def.id);
      // Not checked yet: an added plugin is assumed to work until its status says otherwise.
      if (!st || st.state === "ready") return { ...base, state: "ready" as const };
      return { ...base, state: "needs_setup" as const, message: st.message };
    });
  }

  /** The plugin's definition, for setup steps and fields. */
  definition(id: string): PluginDef {
    return this.def(id);
  }

  /** A fresh status of one plugin; undefined when it is not added. */
  async statusOf(id: string): Promise<PluginStatus | undefined> {
    const r = this.runtime(id);
    if (!r) return undefined;
    let st: PluginStatus;
    try {
      st = await r.status();
    } catch (err) {
      st = { state: "error", message: errorMessage(err) };
    }
    this.noteStatus(id, st);
    return st;
  }

  /**
   * Stores one value the agent found on a page (a key it just created),
   * adding the plugin if needed. The value is checked against the field's
   * pattern and never returned.
   */
  async saveValue(id: string, key: string, value: string): Promise<void> {
    const def = this.def(id);
    const field = def.fields.find((f) => f.key === key);
    if (!field || field.type === "boolean" || field.type === "select") throw new Error(`${def.name} has no text or secret setting "${key}".`);
    const clean = value.trim();
    if (!clean) throw new Error("The value is empty.");
    if (field.pattern && !new RegExp(`^(?:${field.pattern})$`).test(clean)) throw new Error(`That does not look like a ${field.label}.`);
    if (this.installed(id)) await this.configure(id, { [key]: clean });
    else await this.install(id, { [key]: clean });
  }

  /** Secret fields that declare what their values look like, to hide them on pages and find them there. */
  secretPatterns(): { plugin: string; key: string; label: string; re: RegExp }[] {
    return CATALOG.flatMap((d) =>
      d.fields.filter((f) => f.type === "secret" && f.pattern).map((f) => ({ plugin: d.id, key: f.key, label: `${d.name} ${f.label}`, re: new RegExp(f.pattern!, "g") })),
    );
  }

  /** Replaces keys that plugins recognise with a placeholder, so page text shown to the model never carries them. */
  redact(text: string): string {
    let out = text;
    for (const p of this.secretPatterns()) out = out.replace(p.re, `[hidden ${p.label}; save it with plugin_save_from_page plugin=${p.plugin} field=${p.key}]`);
    return out;
  }

  /** Remembers that a thread waits on a plugin, to pick the matter up again once it is ready. */
  waitForSetup(threadId: string, plugin: string): void {
    this.def(plugin);
    const waits = this.waits().filter((w) => !(w.threadId === threadId && w.plugin === plugin));
    waits.push({ threadId, plugin, at: now() });
    this.app.db.setKv(WAITS, waits);
  }

  private waits(): SetupWait[] {
    return (this.app.db.getKv<SetupWait[]>(WAITS) ?? []).filter((w) => now() - w.at < WAIT_TTL);
  }

  /** A plugin just became ready: each thread that waited on it carries on with what the owner asked. */
  private resumeWaiting(plugin: string): void {
    const waits = this.waits();
    const due = waits.filter((w) => w.plugin === plugin);
    if (!due.length) return;
    this.app.db.setKv(
      WAITS,
      waits.filter((w) => w.plugin !== plugin),
    );
    const name = this.def(plugin).name;
    for (const w of due) {
      if (!this.app.threads.get(w.threadId)) continue;
      try {
        this.app.runner.send(w.threadId, `${name} is set up now. Carry on with what I asked for in this thread.`, { source: "vireo" });
      } catch (err) {
        console.warn(`[plugin:${plugin}] could not resume ${w.threadId}: ${errorMessage(err)}`);
      }
    }
  }

  /** Tools from installed plugins. */
  tools(): ToolDef[] {
    return CATALOG.flatMap((d) => this.runtime(d.id)?.tools ?? []);
  }

  /** Specialist agents from installed plugins. */
  agents(): AgentDef[] {
    return CATALOG.flatMap((d) => this.runtime(d.id)?.agents ?? []);
  }

  grants(agent: string): string[] {
    return CATALOG.flatMap((d) => this.runtime(d.id)?.grants?.[agent] ?? []);
  }

  routing(): string[] {
    return CATALOG.map((d) => this.runtime(d.id)?.routing).filter((r): r is string => Boolean(r));
  }

  secrets(): string[] {
    return CATALOG.flatMap((d) => this.runtime(d.id)?.secrets?.() ?? []).filter((s) => s.length >= 4);
  }

  /** Calendar, mail and Drive providers of added plugins. */
  providers(): Providers[] {
    return CATALOG.map((d) => this.runtime(d.id)?.providers).filter((p): p is Providers => Boolean(p));
  }

  /** Results from an installed search plugin, or undefined to use the built-in search. */
  async search(query: string, max: number): Promise<SearchResult[] | undefined> {
    for (const d of CATALOG) {
      const r = this.runtime(d.id);
      if (r?.search) {
        const out = await r.search(query, max);
        if (out) return out;
      }
    }
    return undefined;
  }

  reader(): ReturnType<NonNullable<PluginRuntime["reader"]>> {
    for (const d of CATALOG) {
      const r = this.runtime(d.id)?.reader?.();
      if (r) return r;
    }
    return undefined;
  }

  notify(n: Notification): void {
    for (const d of CATALOG) {
      try {
        this.runtime(d.id)?.notify?.(n);
      } catch (err) {
        console.warn(`[plugin:${d.id}] notify failed: ${errorMessage(err)}`);
      }
    }
  }

  publicRoutes(api: Hono): void {
    for (const r of this.runtimes.values()) r.publicRoutes?.(api);
  }
}
