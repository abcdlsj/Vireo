import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { Db } from "./db.js";
import { addKey, KEYS_KV, PATH, type Key } from "./plugins/endpoint/index.js";

/**
 * Connects the coding agents on this machine to the Vireo node running here,
 * with nothing for the owner to copy: each gets its own key, Vireo as an MCP
 * server, and hooks that tell the owner when a long task finishes or the
 * agent waits on them, and ask their approval before a risky shell command.
 * Running it again replaces what it set up before.
 */

export interface HookConfig {
  url: string;
  key: string;
}

/** Where the hooks find the node and their key; readable by this user only. */
export const hooksFile = (dataDir: string) => join(dataDir, "hooks.json");

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

function connectClaude(url: string, key: string, hookArgs: string[]): string {
  try {
    execFileSync("claude", ["mcp", "remove", "--scope", "user", "vireo"], { stdio: "ignore" });
  } catch {
    // Not added before.
  }
  execFileSync("claude", ["mcp", "add", "--scope", "user", "--transport", "http", "vireo", url, "--header", `Authorization: Bearer ${key}`], { stdio: "ignore" });

  const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
  const settings = readJson<{ hooks?: Record<string, HookEntry[]> }>(file, {});
  const hooks = settings.hooks ?? {};
  const ours = (e: HookEntry) => e.hooks.some((h) => h.command.includes(" hook claude"));
  const add = (event: string, entry: HookEntry) => (hooks[event] = [...(hooks[event] ?? []).filter((e) => !ours(e)), entry]);
  const command = [...hookArgs.map((a) => JSON.stringify(a)), "hook", "claude"].join(" ");
  add("Stop", { hooks: [{ type: "command", command, timeout: 30 }] });
  add("Notification", { hooks: [{ type: "command", command, timeout: 30 }] });
  // Long enough for the owner to answer on their phone.
  add("PreToolUse", { matcher: "Bash", hooks: [{ type: "command", command, timeout: 600 }] });
  writePrivate(file, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
  return "Claude Code: Vireo added as an MCP server; you hear when a long task finishes or it waits on you, and risky shell commands wait for your approval.";
}

function connectCodex(url: string, key: string, hookArgs: string[]): string {
  const file = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  let toml = existsSync(file) ? readFileSync(file, "utf8") : "";
  // Our own block from before, from its marker to the next table or the end.
  toml = toml.replace(/\n?# Added by Vireo \(askvireo connect\)\n\[mcp_servers\.vireo\][\s\S]*?(?=\n\[|$)/, "");
  const notes: string[] = ["Codex: Vireo added as an MCP server"];
  const notify = /^notify\s*=/m.test(toml);
  if (!notify) {
    toml = `notify = ${JSON.stringify([...hookArgs, "hook", "codex"])}\n${toml}`;
    notes.push("you hear when a turn finishes");
  } else if (!/^notify\s*=.*hook", "codex"/m.test(toml)) notes.push("its notify setting was yours already, so it is left alone");
  toml = `${toml.replace(/\s*$/, "")}\n\n# Added by Vireo (askvireo connect)\n[mcp_servers.vireo]\nurl = ${JSON.stringify(url)}\nhttp_headers = { "Authorization" = ${JSON.stringify(`Bearer ${key}`)} }\n`;
  writePrivate(file, toml.replace(/^\n+/, ""));
  return `${notes.join("; ")}.`;
}

/** Connects every coding agent found on this machine; returns one line per agent, empty when there is none. */
export function connectAgents(opts: { dataDir: string; port: number; cli: string; only?: ("claude" | "codex")[] }): string[] {
  const url = `http://127.0.0.1:${opts.port}${PATH}`;
  const hookArgs = [process.execPath, "--disable-warning=ExperimentalWarning", opts.cli];
  const wanted = opts.only ?? ["claude", "codex"];
  const db = Db.open(opts.dataDir);
  const lines: string[] = [];
  try {
    const host = hostname().split(".")[0];
    if (wanted.includes("claude") && has("claude")) lines.push(connectClaude(url, keyFor(db, `Claude Code on ${host}`), hookArgs));
    if (wanted.includes("codex") && has("codex")) lines.push(connectCodex(url, keyFor(db, `Codex on ${host}`), hookArgs));
    if (lines.length) writePrivate(hooksFile(opts.dataDir), `${JSON.stringify({ url, key: keyFor(db, `Hooks on ${host}`) } satisfies HookConfig)}\n`);
  } finally {
    db.close();
  }
  return lines;
}
