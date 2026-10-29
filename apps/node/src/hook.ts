import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hooksFile, type HookConfig } from "./connect.js";

/**
 * What a coding agent's hook runs: tells the owner through Vireo when a long
 * task finishes or the agent waits on them, and asks their approval before a
 * risky shell command. A hook never gets in the agent's way: if Vireo can't be
 * reached, it does nothing and the agent carries on as usual.
 */

/**
 * Shell commands worth the owner's approval: hard to undo, or reaching outside the machine. Each is
 * matched against one simple command with its quoted text blanked, so a word that is only data (a
 * commit message, code written through a heredoc) does not count.
 */
const RISKY = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, // rm -rf, rm -r, rm -f
  /\bgit\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease\b|--delete\b|:)/,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|branch\s+-D)\b/,
  /\b(kubectl|helm)\s+(delete|uninstall|apply|rollout)\b/,
  /\bterraform\s+(apply|destroy)\b/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\bdocker\s+(system\s+prune|rm|rmi)\b/,
  /\b(vercel|wrangler|fly|flyctl)\s+(deploy|--prod)|\bwrangler\s+deploy\b/,
];

/** Programs that are risky as the command itself, never as a word inside one. */
const RISKY_PROGRAM = /^(shutdown|reboot|halt|poweroff|mkfs(\.\w+)?)$/;
/** SQL clients, whose arguments and input are statements they run. */
const SQL_CLIENT = /^(psql|mysql|mariadb|sqlite3|sqlcmd|duckdb|clickhouse-client|clickhouse|cockroach)$/;
const SQL_DROP = /\b(drop|truncate)\s+(table|database|schema)\b/i;
const SHELLS = /^(sh|bash|zsh|dash|ksh|fish)$/;
/** Words that run the next words as the command: `sudo reboot` is a reboot. */
const PREFIX = /^(sudo|doas|env|nohup|time|exec|command|nice|ionice|stdbuf|timeout|xargs)$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** One simple command as the shell would run it. */
interface Simple {
  /** Its words, unquoted, as the program gets them. */
  words: string[];
  /** Its text with quoted parts blanked: what the shell itself reads as syntax. */
  syntax: string;
  /** The input its heredocs feed it. */
  input: string[];
  /** Commands run inside its double-quoted text (`"$(…)"`). */
  inner: string[];
}

/** Reads `$(…)` from `at` (just past the parenthesis) to its closing one. */
function substitution(src: string, at: number): { body: string; end: number } {
  let depth = 1;
  let quote: string | undefined;
  for (let i = at; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return { body: src.slice(at, i), end: i };
  }
  return { body: src.slice(at), end: src.length };
}

const SEPARATORS = new Set(["\n", ";", "&", "|", "(", ")", "`", "{", "}"]);

/**
 * Splits a command line into the simple commands the shell runs: on `;`, `&&`, `||`, `|`, `&`,
 * newlines, subshells and substitutions. Quoted text and heredoc bodies stay data of the command
 * they belong to; comments are dropped.
 */
export function simpleCommands(src: string): Simple[] {
  const out: Simple[] = [];
  const fresh = (): Simple => ({ words: [], syntax: "", input: [], inner: [] });
  let cur = fresh();
  let word = "";
  let inWord = false;
  const heredocs: { simple: Simple; tag: string; strip: boolean }[] = [];

  const endWord = (): void => {
    if (inWord) cur.words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (cur.words.length || cur.input.length || cur.inner.length) out.push(cur);
    cur = fresh();
  };
  /** After a line that opened heredocs: their bodies, in order, each up to its tag. Returns where the next line starts. */
  const readBodies = (at: number): number => {
    for (const h of heredocs) {
      const lines: string[] = [];
      while (at < src.length) {
        const nl = src.indexOf("\n", at);
        const line = src.slice(at, nl < 0 ? src.length : nl);
        at = nl < 0 ? src.length : nl + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.tag) break;
        lines.push(line);
      }
      h.simple.input.push(lines.join("\n"));
    }
    heredocs.length = 0;
    return at;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      word += src[i + 1] ?? "";
      inWord = true;
      cur.syntax += " ";
      i++;
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      const end = close < 0 ? src.length : close;
      word += src.slice(i + 1, end);
      inWord = true;
      cur.syntax += '""';
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === "\\") word += src[++j] ?? "";
        else if (src[j] === "$" && src[j + 1] === "(") {
          const sub = substitution(src, j + 2);
          cur.inner.push(sub.body);
          j = sub.end;
        } else if (src[j] === "`") {
          const close = src.indexOf("`", j + 1);
          const end = close < 0 ? src.length : close;
          cur.inner.push(src.slice(j + 1, end));
          j = end;
        } else word += src[j];
      }
      inWord = true;
      cur.syntax += '""';
      i = j;
    } else if (c === "#" && !inWord) {
      const nl = src.indexOf("\n", i);
      i = (nl < 0 ? src.length : nl) - 1;
    } else if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      // A heredoc: its tag now, its body once this line ends.
      const m = /^<<(-?)[ \t]*(['"]?)([^\s'";&|<>()]+)\2/.exec(src.slice(i));
      if (!m) {
        cur.syntax += c;
        continue;
      }
      endWord();
      heredocs.push({ simple: cur, tag: m[3]!, strip: m[1] === "-" });
      cur.syntax += " ";
      i += m[0].length - 1;
    } else if (SEPARATORS.has(c) && !((c === "{" || c === "}") && inWord)) {
      // `$(` separates too: what it runs is a command of its own.
      if (c === "(" && word.endsWith("$")) word = word.slice(0, -1);
      endCommand();
      if (c === "\n" && heredocs.length) i = readBodies(i + 1) - 1;
    } else if (c === " " || c === "\t") {
      endWord();
      cur.syntax += c;
    } else {
      word += c;
      inWord = true;
      cur.syntax += c;
    }
  }
  endCommand();
  return out;
}

/** The program a simple command runs, with its arguments: past `sudo`, `env`, `FOO=1` and their options. */
function program(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (ASSIGNMENT.test(w)) i++;
    else if (PREFIX.test(w.replace(/^.*\//, ""))) {
      i++;
      // The prefix's own options, the value after sudo's -u / -g, and timeout's duration.
      while (i < words.length && (words[i]!.startsWith("-") || /^\d+[smhd]?$/.test(words[i]!))) i += /^-[ugCDhpTr]$/.test(words[i]!) ? 2 : 1;
    } else break;
  }
  return words.slice(i);
}

/** What ssh runs on the other side: the words after its options and the host. */
function sshCommand(args: string[]): string {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += /^-[bcDEeFIiJLlmOopQRSWw]$/.test(args[i]!) ? 2 : 1;
  return args.slice(i + 1).join(" ");
}

function riskySimple(c: Simple, depth: number): boolean {
  if (RISKY.some((r) => r.test(c.syntax))) return true;
  if (c.inner.some((s) => riskyAt(s, depth + 1))) return true;
  const [cmd = "", ...args] = program(c.words);
  const name = cmd.replace(/^.*\//, "");
  if (RISKY_PROGRAM.test(name)) return true;
  if (name === "dd" && args.some((a) => a.startsWith("if="))) return true;
  if (SQL_CLIENT.test(name)) return SQL_DROP.test([...args, ...c.input].join("\n"));
  // What a shell, eval or ssh is handed is a command line of its own.
  if (SHELLS.test(name)) {
    const script = args.indexOf("-c");
    if (script >= 0) return riskyAt(args[script + 1] ?? "", depth + 1);
    return c.input.some((s) => riskyAt(s, depth + 1));
  }
  if (name === "eval") return riskyAt(args.join(" "), depth + 1);
  if (name === "ssh") return riskyAt(sshCommand(args), depth + 1);
  return false;
}

function riskyAt(command: string, depth: number): boolean {
  // Deeper than anyone writes by hand: ask rather than guess.
  if (depth > 4) return true;
  return simpleCommands(command).some((c) => riskySimple(c, depth));
}

export function risky(command: string): boolean {
  return riskyAt(command, 0);
}

/** A turn shorter than this ends with the owner still watching; no need to tell them. */
const LONG_TURN_MS = 2 * 60_000;

async function withVireo<T>(dataDir: string, fn: (call: (tool: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<string>) => Promise<T>): Promise<T | undefined> {
  let cfg: HookConfig;
  try {
    cfg = JSON.parse(readFileSync(hooksFile(dataDir), "utf8")) as HookConfig;
  } catch {
    return undefined;
  }
  const client = new Client({ name: "vireo hooks", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: { authorization: `Bearer ${cfg.key}` } } }));
    return await fn(async (tool, args, timeoutMs = 20_000) => {
      const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
      return ((r.content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("\n");
    });
  } catch {
    return undefined;
  } finally {
    await client.close().catch(() => undefined);
  }
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: string | { type: string; text?: string }[] };
}

/** When the owner last wrote, and what the agent said last, from Claude Code's transcript. */
function lastTurn(path: string | undefined): { startedAt?: number; said?: string } {
  if (!path) return {};
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n").slice(-400);
    let said: string | undefined;
    let startedAt: number | undefined;
    for (const raw of lines.reverse()) {
      let l: TranscriptLine;
      try {
        l = JSON.parse(raw) as TranscriptLine;
      } catch {
        continue;
      }
      const content = l.message?.content;
      const textOf = typeof content === "string" ? content : (content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      if (!said && l.type === "assistant" && textOf.trim()) said = textOf.trim();
      // The owner's own message, not a tool result (which arrives as a user line too).
      if (l.type === "user" && textOf.trim() && !(Array.isArray(content) && content.some((c) => c.type === "tool_result"))) {
        startedAt = l.timestamp ? Date.parse(l.timestamp) : undefined;
        break;
      }
    }
    return { startedAt, said };
  } catch {
    return {};
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface ClaudeHook {
  hook_event_name?: string;
  cwd?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
  message?: string;
  tool_name?: string;
  tool_input?: { command?: string; description?: string };
}

export async function runHook(kind: string, dataDir: string, argv: string[]): Promise<void> {
  // The CLI is serving as Vireo's own model (see cli-model.ts): nothing to tell the owner.
  if (process.env.VIREO_AS_MODEL) return;
  if (kind === "codex") {
    // Codex passes one JSON argument when a turn completes.
    let e: { type?: string; "last-assistant-message"?: string; cwd?: string } = {};
    try {
      e = JSON.parse(argv.at(-1) ?? "{}");
    } catch {
      return;
    }
    if (e.type !== "agent-turn-complete") return;
    await withVireo(dataDir, (call) => call("notify_owner", { title: "Codex finished", body: clip(e["last-assistant-message"] ?? "", 300), from: `Codex${e.cwd ? ` in ${basename(e.cwd)}` : ""}` }));
    return;
  }
  if (kind !== "claude") return;
  let e: ClaudeHook;
  try {
    e = JSON.parse(await readStdin()) as ClaudeHook;
  } catch {
    return;
  }
  const from = `Claude Code${e.cwd ? ` in ${basename(e.cwd)}` : ""}`;
  if (e.hook_event_name === "Stop") {
    if (e.stop_hook_active) return;
    const turn = lastTurn(e.transcript_path);
    if (!turn.startedAt || Date.now() - turn.startedAt < LONG_TURN_MS) return;
    await withVireo(dataDir, (call) => call("notify_owner", { title: "Claude Code finished", body: clip(turn.said ?? "", 300), from }));
  } else if (e.hook_event_name === "Notification") {
    await withVireo(dataDir, (call) => call("notify_owner", { title: "Claude Code needs you", body: clip(e.message ?? "", 300), from }));
  } else if (e.hook_event_name === "PreToolUse" && e.tool_name === "Bash") {
    const command = e.tool_input?.command ?? "";
    if (!risky(command)) return;
    const out = await withVireo(dataDir, (call) =>
      call("request_approval", { summary: clip(`Run: ${command.replace(/\s+/g, " ")}`, 180), details: [e.tool_input?.description, e.cwd && `In ${e.cwd}`, command].filter(Boolean).join("\n\n"), from, wait_seconds: 540 }, 560_000),
    );
    // Unreachable or still undecided: Claude Code asks in the terminal as it always does.
    const decision = out?.startsWith("approved") ? "allow" : out?.startsWith("declined") || out?.startsWith("not approved") ? "deny" : undefined;
    if (!decision) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision,
          permissionDecisionReason: decision === "allow" ? "Approved by the owner in Vireo." : "Declined by the owner in Vireo.",
        },
      }),
    );
  }
}
