import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Type, type TSchema } from "typebox";
import { defineTool } from "../../tools/types.js";
import { errorMessage, newId, now, sha256, truncate } from "../../util.js";
import { VERSION } from "../../version.js";
import type { PluginContext, PluginDef, PluginStatus } from "../types.js";

/**
 * Vireo over MCP: this node serves a Model Context Protocol endpoint, so
 * Claude Code, Codex, scripts and the owner's other Vireo nodes can reach
 * Vireo the way Vireo reaches them. They can ask Vireo something, read its
 * threads and memory, tell the owner something, and ask the owner to approve
 * a step; the approval is an ordinary confirmation card, so it shows in the
 * app, in push notifications and in linked chats.
 *
 * The endpoint lives under /public/ so the cloud relay passes it through
 * without a cloud sign-in; every request must carry one of the keys made
 * here, which are stored only as hashes.
 */

export const PATH = "/public/mcp";
const APPROVAL_TOOL = "agent_approval";

interface EndpointConfig {
  memory: boolean;
}

interface Key {
  id: string;
  name: string;
  hash: string;
  /** Last four characters, so the owner can tell keys apart. */
  hint: string;
  createdAt: number;
  usedAt: number | null;
  /** A key for one of the owner's own Vireo nodes: it may also confirm or decline this node's pending confirmations, after the owner did so there. */
  node?: boolean;
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const seconds = (v: unknown, fallback: number, max: number): number => {
  const n = Number(v);
  return Math.max(0, Math.min(Number.isFinite(n) ? n : fallback, max)) * 1000;
};
const when = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

/** The MCP tools other agents see. Schemas are plain JSON Schema (typebox). */
function toolList(memory: boolean, node: boolean) {
  const from = Type.Optional(Type.String({ description: "Who is asking, e.g. “Claude Code on my laptop”. Shown to the owner." }));
  const wait = (d: number, max: number) => Type.Optional(Type.Number({ minimum: 0, maximum: max, description: `Seconds to wait for the outcome before returning (default ${d}). Check again later if it is not ready.` }));
  const tools: { name: string; description: string; inputSchema: TSchema }[] = [
    {
      name: "ask_vireo",
      description:
        "Ask the owner's personal agent, Vireo, to do or answer something. It knows the owner (calendar, email, memory, their machines and plugins) and asks the owner before anything outward-facing. Starts a new thread unless thread_id continues one. Returns Vireo's reply, or the thread id to check later.",
      inputSchema: Type.Object({
        text: Type.String({ description: "The request, with the context Vireo needs; it cannot see your conversation." }),
        thread_id: Type.Optional(Type.String({ description: "Continue this thread instead of starting one." })),
        from,
        temporary: Type.Optional(Type.Boolean({ description: "A one-off: Vireo does not remember anything from it." })),
        wait_seconds: wait(60, 600),
      }),
    },
    {
      name: "node_info",
      description: "What this Vireo node is and what it can do now: its machine, and each plugin it has with what it is set up for (coding agents and their repositories, MCP servers, tailnet, chats).",
      inputSchema: Type.Object({}),
    },
    {
      name: "read_thread",
      description: "Read a Vireo thread: its latest messages, whether Vireo is still working, and confirmations waiting on the owner.",
      inputSchema: Type.Object({ thread_id: Type.String(), max_chars: Type.Optional(Type.Number({ minimum: 500, maximum: 20000 })) }),
    },
    {
      name: "list_threads",
      description: "List Vireo's open threads, or find threads (closed ones too) matching a query.",
      inputSchema: Type.Object({ query: Type.Optional(Type.String()) }),
    },
    {
      name: "request_approval",
      description:
        "Ask the owner to approve a step before you take it (deploying, deleting, spending, sending). They get a confirmation card in the Vireo app, a push notification and their linked chats, and can approve, edit the details, or decline. Returns approved, declined, or pending with an id for approval_status.",
      inputSchema: Type.Object({
        summary: Type.String({ description: "One line: what you want to do, e.g. “Deploy api to production”." }),
        details: Type.Optional(Type.String({ description: "What the owner needs to decide: what changes, what it affects, how to undo it." })),
        from,
        wait_seconds: wait(90, 600),
      }),
    },
    {
      name: "approval_status",
      description: "Check, or keep waiting on, an approval asked for with request_approval.",
      inputSchema: Type.Object({ approval_id: Type.String(), wait_seconds: wait(0, 600) }),
    },
    {
      name: "notify_owner",
      description: "Tell the owner something now (a finished job, a failure that needs them), by push notification and their linked chats. Nothing is asked of Vireo.",
      inputSchema: Type.Object({ title: Type.String(), body: Type.Optional(Type.String()), from }),
    },
  ];
  if (node)
    tools.push({
      name: "decide_action",
      description:
        "Confirm or decline a confirmation waiting on this node (its id is in brackets in ask_vireo and read_thread). Only call it with the owner's own decision, which they made on a confirmation card of yours. Confirming runs the action and lets Vireo continue; the reply comes back.",
      inputSchema: Type.Object({
        action_id: Type.String(),
        decision: Type.Union([Type.Literal("confirm"), Type.Literal("decline")]),
        reason: Type.Optional(Type.String({ description: "Why the owner declined, for Vireo." })),
        expected_summary: Type.Optional(Type.String({ description: "The summary the owner saw; the call is refused if it is not this confirmation's." })),
        wait_seconds: wait(60, 600),
      }),
    });
  if (memory)
    tools.push({
      name: "search_memory",
      description: "Search what Vireo remembers about the owner: people, preferences, projects, places, how they like things done.",
      inputSchema: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })) }),
    });
  return tools;
}

function serve(ctx: PluginContext, key: Key, keys: { touch(id: string): void }): Server {
  const host = ctx.host;
  const cfg = () => ctx.config<EndpointConfig>();
  const server = new Server(
    { name: "vireo", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Vireo is the owner's personal agent. Use ask_vireo for anything about the owner's life, accounts and machines; request_approval before risky steps; notify_owner when something finished or needs them.",
    },
  );
  const sender = (from: unknown) => (typeof from === "string" && from.trim() ? `${from.trim().slice(0, 60)} (${key.name})` : key.name);

  /** Resolves with what Vireo said when a run in the thread that began after `since` ends; undefined on timeout. */
  const runEnd = (threadId: string, since: number, ms: number, signal: AbortSignal) =>
    new Promise<string | undefined>((done) => {
      if (ms <= 0) return done(undefined);
      const finish = (v: string | undefined) => {
        clearTimeout(timer);
        off();
        signal.removeEventListener("abort", abort);
        done(v);
      };
      const abort = () => finish(undefined);
      const off = host.onRunFinished((id, said, startedAt) => {
        if (id === threadId && startedAt >= since) finish(said);
      });
      const timer = setTimeout(() => finish(undefined), ms);
      signal.addEventListener("abort", abort);
    });

  const pendingIn = (threadId: string) => host.actions.forThread(threadId).filter((a) => a.status === "pending");
  const waitingLine = (threadId: string) => {
    const waiting = pendingIn(threadId);
    return waiting.length ? `Waiting on the owner to confirm: ${waiting.map((w) => `[${w.id}] ${w.summary}`).join("; ")}.` : "";
  };

  const approval = async (id: string, ms: number, signal: AbortSignal): Promise<CallToolResult> => {
    let a = host.actions.get(id);
    if (!a || a.tool !== APPROVAL_TOOL) return text(`No approval ${id}.`, true);
    const until = Date.now() + ms;
    while (a.status === "pending" && Date.now() < until && !signal.aborted) {
      await new Promise((r) => setTimeout(r, 1000));
      a = host.actions.get(id)!;
    }
    if (a.status === "pending") return text(`pending: the owner has not decided yet. Call approval_status with approval_id "${id}" to keep waiting.`);
    if (a.status === "cancelled") return text("declined: the owner declined. Do not take this step.");
    if (a.status === "failed") return text(`not approved: ${a.result ?? "the approval did not go through"}. Do not take this step.`);
    const details = typeof a.args.description === "string" ? a.args.description : "";
    return text(`approved: the owner approved “${a.summary}”.${details ? `\nDetails as approved (the owner may have edited them):\n${details}` : ""}`);
  };

  const call = async (name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> => {
    switch (name) {
      case "ask_vireo": {
        const ask = String(args.text ?? "").trim();
        if (!ask) return text("text is empty.", true);
        let threadId = typeof args.thread_id === "string" ? args.thread_id : "";
        if (threadId && !host.threads.get(threadId)) return text(`No thread ${threadId}.`, true);
        if (!threadId) threadId = host.threads.create({ temporary: Boolean(args.temporary), origin: { kind: "mcp", from: sender(args.from) } }).id;
        const since = now();
        host.send(threadId, `[From ${sender(args.from)}, an agent the owner connected over MCP]\n${ask}`);
        const said = await runEnd(threadId, since, seconds(args.wait_seconds, 60, 600), signal);
        const waiting = waitingLine(threadId);
        const tail = waiting ? `\n\n${waiting}` : "";
        if (said === undefined) return text(`Vireo is still working on it in thread ${threadId}. Read it later with read_thread.${tail}`);
        return text(`${said || "(Vireo finished without a reply.)"}${tail}\n\nthread_id: ${threadId}`);
      }
      case "read_thread": {
        const id = String(args.thread_id ?? "");
        const t = host.threads.get(id);
        if (!t) return text(`No thread ${id}.`, true);
        const head = [`${t.title} · ${t.state === "done" ? "done" : t.running ? "Vireo is working" : "open"}`, waitingLine(id)].filter(Boolean);
        return text(`${head.join("\n")}\n\n${host.threads.transcript(id, { maxChars: Number(args.max_chars) || 6000 }) || "(no messages yet)"}`);
      }
      case "list_threads": {
        const q = typeof args.query === "string" ? args.query.trim() : "";
        const rows = q
          ? host.threads.search(q, 15).map((r) => `${r.thread.id} · ${r.thread.title} · ${r.thread.state} · ${truncate(r.snippet, 160)}`)
          : host.threads
              .list()
              .filter((t) => t.state === "active")
              .slice(0, 30)
              .map((t) => `${t.id} · ${t.title}${t.running ? " · working" : ""}${t.pendingActions ? " · needs the owner" : ""}${t.statusLine ? ` · ${t.statusLine}` : ""}`);
        return text(rows.join("\n") || "No threads.");
      }
      case "request_approval": {
        const summary = String(args.summary ?? "").trim().replace(/\s+/g, " ");
        if (!summary) return text("summary is empty.", true);
        const who = sender(args.from);
        const thread = host.threads.create({ title: truncate(`Approve: ${summary}`, 80), temporary: true, origin: { kind: "mcp", from: who } });
        const fields: Record<string, unknown> = { from: who };
        if (typeof args.details === "string" && args.details.trim()) fields.description = args.details.trim();
        const action = host.actions.create(thread.id, APPROVAL_TOOL, fields, truncate(summary, 200));
        return approval(action.id, seconds(args.wait_seconds, 90, 600), signal);
      }
      case "node_info":
        return text(await host.describe());
      case "decide_action": {
        if (!key.node) return text("This key cannot decide confirmations.", true);
        const id = String(args.action_id ?? "");
        const a = host.actions.get(id);
        if (!a) return text(`No confirmation ${id}.`, true);
        if (a.status !== "pending") return text(`Already ${a.status}${a.result ? `: ${a.result}` : ""}.`);
        const norm = (v: string) => v.replace(/\s+/g, " ").trim().toLowerCase();
        if (typeof args.expected_summary === "string" && norm(args.expected_summary) !== norm(a.summary))
          return text(`Not decided: ${id} is “${a.summary}”, not what the owner saw. Ask the owner about this one.`, true);
        if (args.decision === "decline") {
          host.actions.cancel(id, typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : undefined);
          return text(`Declined: ${a.summary}.`);
        }
        const since = now();
        const done = await host.actions.confirm(id);
        // An agent's approval settles there; anything else lets Vireo carry on, so wait for what it says.
        const settles = a.tool === APPROVAL_TOOL;
        const said = done.status === "pending" || settles ? undefined : await runEnd(a.threadId, since, seconds(args.wait_seconds, 60, 600), signal);
        const lines = [`${done.status === "done" ? "Done" : done.status === "failed" ? "Failed" : `Now ${done.status}`}: ${a.summary}.`];
        if (done.result) lines.push(done.result);
        if (said) lines.push(`\nVireo: ${said}`);
        else if (!settles) lines.push(`\nVireo is carrying on in thread ${a.threadId}; read it with read_thread.`);
        const waiting = waitingLine(a.threadId);
        if (waiting) lines.push(waiting);
        return text(lines.join("\n"));
      }
      case "approval_status":
        return approval(String(args.approval_id ?? ""), seconds(args.wait_seconds, 0, 600), signal);
      case "notify_owner": {
        const title = String(args.title ?? "").trim();
        if (!title) return text("title is empty.", true);
        host.notify({ title: truncate(`${title} · ${sender(args.from)}`, 120), body: truncate(String(args.body ?? ""), 1000) });
        return text("Sent to the owner.");
      }
      case "search_memory": {
        if (!cfg().memory) return text("The owner has not shared Vireo's memory with agents.", true);
        const facts = host.memory.list({ query: String(args.query ?? ""), limit: Math.min(Number(args.limit) || 15, 50) });
        return text(facts.map((f) => `- ${f.entityName}: ${f.statement}`).join("\n") || "Nothing remembered about that.");
      }
      default:
        return text(`Unknown tool: ${name}`, true);
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList(cfg().memory, Boolean(key.node)) as never }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    keys.touch(key.id);
    try {
      return await call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, extra.signal);
    } catch (err) {
      return text(host.redact(errorMessage(err)), true);
    }
  });
  return server;
}

export const endpointPlugin: PluginDef = {
  id: "endpoint",
  name: "Vireo over MCP",
  description:
    "Let your other agents reach Vireo: Claude Code, Codex, scripts and your other Vireo nodes connect over MCP to ask Vireo, read its threads, notify you, and ask your approval before risky steps.",
  author: "Vireo community",
  homepage: "https://modelcontextprotocol.io/docs/develop/connect-remote-servers",
  fields: [{ key: "memory", label: "Share memory", type: "boolean", default: true, help: "Agents with a key can search what Vireo remembers about you." }],
  create(ctx) {
    const list = (): Key[] => ctx.state.get<Key[]>("keys") ?? [];
    const save = (keys: Key[]) => ctx.state.set("keys", keys);
    const url = () => `${ctx.host.publicUrl().replace(/\/$/, "")}${PATH}`;
    const keys = {
      touch(id: string) {
        const all = list();
        const k = all.find((x) => x.id === id);
        // One write a minute is enough to show when a key was last used.
        if (!k || (k.usedAt && now() - k.usedAt < 60_000)) return;
        k.usedAt = now();
        save(all);
      },
    };
    const match = (secret: string | undefined): Key | undefined => {
      if (!secret) return undefined;
      const hash = sha256(secret);
      return list().find((k) => k.hash === hash);
    };

    return {
      tools: [
        defineTool({
          name: APPROVAL_TOOL,
          label: "Approve an agent's request",
          description: "An approval an agent asked the owner for over MCP. Only the owner's confirmation card runs it.",
          parameters: Type.Object({ from: Type.String(), description: Type.Optional(Type.String()) }),
          confirm: () => true,
          settles: true,
          async run(args) {
            return { text: `Approved; ${args.from} is told when it checks.`, display: { note: `${args.from} can go ahead.` } };
          },
        }),
      ],
      async status(): Promise<PluginStatus> {
        const all = list();
        const details = [
          { label: "Server URI", value: url() },
          ...all.map((k) => ({ label: k.name, value: `${k.node ? "node key, " : ""}…${k.hint}, made ${when(k.createdAt)}, ${k.usedAt ? `last used ${when(k.usedAt)}` : "not used yet"}` })),
        ];
        if (!all.length) return { state: "setup", message: "Press New key, then add Vireo to your agent with the command it shows.", details };
        return { state: "ready", message: `Agents with one of your ${all.length === 1 ? "key" : `${all.length} keys`} can reach Vireo at this address.`, details };
      },
      actions() {
        return [{ id: "new", label: "New key", primary: list().length === 0 }, { id: "new_node", label: "New key for a Vireo node" }, ...(list().length ? [{ id: "revoke", label: "Revoke all keys" }] : [])];
      },
      async runAction(id) {
        if (id === "new" || id === "new_node") {
          const node = id === "new_node";
          const all = list();
          const secret = `vireo_${randomBytes(24).toString("base64url")}`;
          const name = `Key ${all.reduce((n, k) => Math.max(n, Number(k.name.replace(/\D/g, "")) || 0), 0) + 1}`;
          save([...all, { id: newId("key"), name, hash: sha256(secret), hint: secret.slice(-4), createdAt: now(), usedAt: null, ...(node ? { node: true } : {}) }]);
          if (node)
            return {
              message: [
                `${name}, for another of your Vireo nodes, shown only this once. It can also confirm what you confirm there.`,
                "",
                "On that node, in Settings → Plugins → Other nodes, add a row with:",
                `Address: ${url()}`,
                `Key: ${secret}`,
              ].join("\n"),
            };
          return {
            message: [
              `${name}, shown only this once: ${secret}`,
              "",
              "Claude Code:",
              `claude mcp add --transport http vireo ${url()} --header "Authorization: Bearer ${secret}"`,
              "",
              "Another Vireo node (Settings → Plugins → MCP servers):",
              `"vireo": { "url": "${url()}", "headers": { "Authorization": "Bearer ${secret}" } }`,
            ].join("\n"),
          };
        }
        if (id === "revoke") {
          save([]);
          return { message: "Revoked. No agent can reach Vireo over MCP until you make a new key." };
        }
        throw new Error(`Unknown action: ${id}`);
      },
      publicRoutes(api) {
        api.all(PATH, async (c) => {
          if (!ctx.enabled()) return c.json({ error: "Not enabled" }, 404);
          const auth = c.req.header("authorization");
          const key = match(auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined);
          if (!key) return c.json({ error: "A Vireo key is required: Settings → Plugins → Vireo over MCP → New key." }, 401);
          // Stateless: every request gets its own server, so nothing is kept between calls.
          const server = serve(ctx, key, keys);
          const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          await server.connect(transport);
          try {
            return await transport.handleRequest(c.req.raw);
          } finally {
            void server.close();
          }
        });
      },
    };
  },
};
