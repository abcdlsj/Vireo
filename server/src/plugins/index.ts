import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { AgentDef } from "../agents.js";
import type { App } from "../app.js";
import { bus } from "../bus.js";
import type { Notification } from "../push.js";
import type { ToolDef } from "../tools/types.js";
import { errorMessage } from "../util.js";
import type { SearchResult } from "../tools/research.js";
import { feishuPlugin } from "./feishu/index.js";
import { googlePlugin } from "./google/index.js";
import { mcpPlugin } from "./mcp/index.js";
import { searchPlugin } from "./search/index.js";
import { tailscalePlugin } from "./tailscale/index.js";
import { telegramPlugin } from "./telegram/index.js";
import type { ActionResult, PluginDef, PluginRuntime, PluginStatus, RequestInfo } from "./types.js";

export * from "./types.js";

/** The community catalog: every plugin that ships with Vireo. */
export const CATALOG: PluginDef[] = [googlePlugin, tailscalePlugin, telegramPlugin, feishuPlugin, mcpPlugin, searchPlugin];

interface Stored {
  enabled: boolean;
  /** Plain values; secret fields are stored as vault ciphertext under "enc:<key>". */
  config: Record<string, unknown>;
}

export interface PluginView {
  id: string;
  name: string;
  description: string;
  author: string;
  homepage?: string;
  installed: boolean;
  fields: (PluginDef["fields"][number] & { set?: boolean })[];
  config: Record<string, unknown>;
  status?: PluginStatus;
  actions: { id: string; label: string; primary?: boolean }[];
}

const KEY = "plugins";

/** Installs, configures and runs plugins; installed plugins survive restarts. */
export class Plugins {
  private readonly runtimes = new Map<string, PluginRuntime>();

  constructor(private readonly app: App) {
    for (const def of CATALOG) {
      const dir = join(app.config.dataDir, "plugins", def.id);
      this.runtimes.set(
        def.id,
        def.create({
          app,
          id: def.id,
          dir,
          config: <T>() => this.config(def.id) as T,
          setConfig: (patch) => this.write(def.id, patch),
          changed: () => this.changed(),
        }),
      );
    }
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
  }

  async uninstall(id: string): Promise<void> {
    this.def(id);
    await this.runtimes.get(id)?.stop?.().catch(() => undefined);
    const all = this.all();
    delete all[id];
    this.app.db.setKv(KEY, all);
    this.changed();
  }

  async configure(id: string, patch: Record<string, unknown>): Promise<void> {
    if (!this.installed(id)) throw new Error("Add the plugin first.");
    this.write(id, patch);
    await this.runtimes.get(id)?.stop?.().catch(() => undefined);
    await this.startOne(id);
    this.changed();
  }

  async action(id: string, actionId: string, req: RequestInfo): Promise<ActionResult> {
    const r = this.runtime(id);
    if (!r?.runAction) throw new Error("This plugin has no actions.");
    const out = await r.runAction(actionId, req);
    this.changed();
    return out;
  }

  private changed(): void {
    this.app.tools = this.app.buildTools();
    bus.publish({ type: "plugins.updated" });
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
    };
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
