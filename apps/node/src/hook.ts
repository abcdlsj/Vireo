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

/** Shell commands worth the owner's approval: hard to undo, or reaching outside the machine. */
const RISKY = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, // rm -rf, rm -r, rm -f
  /\bgit\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease\b|--delete\b|:)/,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|branch\s+-D)\b/,
  /\b(kubectl|helm)\s+(delete|uninstall|apply|rollout)\b/,
  /\bterraform\s+(apply|destroy)\b/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\bdocker\s+(system\s+prune|rm|rmi)\b/,
  /\b(drop|truncate)\s+(table|database|schema)\b/i,
  /\b(shutdown|reboot|mkfs|dd\s+if=)/,
  /\b(vercel|wrangler|fly|flyctl)\s+(deploy|--prod)|\bwrangler\s+deploy\b/,
];

export function risky(command: string): boolean {
  return RISKY.some((r) => r.test(command));
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
