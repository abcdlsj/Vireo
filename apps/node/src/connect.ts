import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { Db } from "./db.js";
import { addKey, KEYS_KV, PATH, type Key } from "./plugins/endpoint/index.js";

/**
 * Connects the coding agents on this machine to the Vireo node running here,
 * with nothing for the owner to copy: each gets its own key and Vireo as an MCP
 * server. Nothing else of the owner's own sessions changes: no hooks, no notify.
 * The sessions Vireo runs itself go through ACP, where it sees every step and
 * permission request already. Running it again replaces what it set up before,
 * and takes out the hooks earlier versions added.
 */

/** Where earlier versions kept the hooks' key; removed on connect. */
const oldHooksFile = (dataDir: string) => join(dataDir, "hooks.json");

const has = (bin: string) => {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writePrivate(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Adds Vireo over MCP (if the owner had not) and a key for one agent. */
function keyFor(db: Db, name: string): string {
  const plugins = db.getKv<Record<string, { enabled: boolean; config: Record<string, unknown> }>>("plugins") ?? {};
  if (!plugins.endpoint?.enabled) db.setKv("plugins", { ...plugins, endpoint: { enabled: true, config: plugins.endpoint?.config ?? {} } });
  return addKey({ get: () => db.getKv<Key[]>(KEYS_KV) ?? [], set: (keys) => db.setKv(KEYS_KV, keys) }, name).secret;
}

type HookEntry = { matcher?: string; hooks: { type: "command"; command: string; timeout?: number }[] };

function connectClaude(url: string, key: string): string {
  try {
    execFileSync("claude", ["mcp", "remove", "--scope", "user", "vireo"], { stdio: "ignore" });
  } catch {
    // Not added before.
  }
  execFileSync("claude", ["mcp", "add", "--scope", "user", "--transport", "http", "vireo", url, "--header", `Authorization: Bearer ${key}`], { stdio: "ignore" });

  // Earlier versions hooked every session of the owner's (Stop, Notification, PreToolUse on Bash).
  const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
  const settings = readJson<{ hooks?: Record<string, HookEntry[]> }>(file, {});
  if (settings.hooks) {
    const ours = (e: HookEntry) => e.hooks.some((h) => h.command.includes(" hook claude"));
    let changed = false;
    const hooks: Record<string, HookEntry[]> = {};
    for (const [event, entries] of Object.entries(settings.hooks)) {
      const kept = entries.filter((e) => !ours(e));
      if (kept.length !== entries.length) changed = true;
      if (kept.length) hooks[event] = kept;
    }
    if (changed) writePrivate(file, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
  }
  return "Claude Code: Vireo added as an MCP server.";
}

function connectCodex(url: string, key: string): string {
  const file = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  let toml = existsSync(file) ? readFileSync(file, "utf8") : "";
  // Our own block from before, from its marker to the next table or the end.
  toml = toml.replace(/\n?# Added by Vireo \(askvireo connect\)\n\[mcp_servers\.vireo\][\s\S]*?(?=\n\[|$)/, "");
  // The notify earlier versions added; one of the owner's own stays.
  toml = toml.replace(/^notify\s*=.*"hook",\s*"codex"\]\n?/m, "");
  toml = `${toml.replace(/\s*$/, "")}\n\n# Added by Vireo (askvireo connect)\n[mcp_servers.vireo]\nurl = ${JSON.stringify(url)}\nhttp_headers = { "Authorization" = ${JSON.stringify(`Bearer ${key}`)} }\n`;
  writePrivate(file, toml.replace(/^\n+/, ""));
  return "Codex: Vireo added as an MCP server.";
}

/** Connects every coding agent found on this machine; returns one line per agent, empty when there is none. */
export function connectAgents(opts: { dataDir: string; port: number; only?: ("claude" | "codex")[] }): string[] {
  const url = `http://127.0.0.1:${opts.port}${PATH}`;
  const wanted = opts.only ?? ["claude", "codex"];
  const db = Db.open(opts.dataDir);
  const lines: string[] = [];
  try {
    const host = hostname().split(".")[0];
    if (wanted.includes("claude") && has("claude")) lines.push(connectClaude(url, keyFor(db, `Claude Code on ${host}`)));
    if (wanted.includes("codex") && has("codex")) lines.push(connectCodex(url, keyFor(db, `Codex on ${host}`)));
    // The hooks' own key, from earlier versions, goes with them.
    const keys = db.getKv<Key[]>(KEYS_KV) ?? [];
    const left = keys.filter((k) => k.name !== `Hooks on ${host}`);
    if (left.length !== keys.length) db.setKv(KEYS_KV, left);
    rmSync(oldHooksFile(opts.dataDir), { force: true });
  } finally {
    db.close();
  }
  return lines;
}
