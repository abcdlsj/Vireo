import { execFile } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool } from "../../tools/types.js";
import { errorMessage, truncate } from "../../util.js";
import type { ConfigField, PluginDef, PluginRuntime, PluginStatus } from "../types.js";

/**
 * Desktop apps: Vireo reads and operates native macOS apps through the
 * system accessibility tree, with agent-desktop (vercel-labs) doing the
 * reading and the acting. A desktop action is not confined to one window the
 * way a browser tab is, so every action is confirmed and only the apps the
 * owner listed may be touched.
 */

type Action = "click" | "toggle" | "check" | "uncheck" | "set_value" | "type" | "select";

const COMMAND: Record<Action, string> = {
  click: "click",
  toggle: "toggle",
  check: "check",
  uncheck: "uncheck",
  set_value: "set-value",
  type: "type",
  select: "select",
};

/** Actions that write text or pick an option need a value. */
const VALUED: Action[] = ["set_value", "type", "select"];

interface DesktopConfig {
  apps: string;
  binary: string;
}

/** agent-desktop prints one JSON envelope per call; `ok` true carries `data`, false carries `error`. */
interface Envelope {
  version: string;
  ok: boolean;
  command: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; suggestion?: string };
}

interface Node {
  role?: string;
  name?: string;
  value?: string;
  ref_id?: string;
  states?: string[];
  available_actions?: string[];
  children?: Node[];
  children_count?: number;
}

interface Match {
  role?: string;
  name?: string;
  value?: string | null;
  ref_id?: string;
  states?: string[];
  path?: string[];
}

/** One process per call, so the namespace refs live in must be stable across calls. */
const SESSION = "vireo";
const TREE_CAP = 12_000;
const FIELD_CAP = 160;
const LINE_CAP = 400;

const quote = (s: string) => JSON.stringify(truncate(s, FIELD_CAP));

/** The tree as the model reads it: one line per element, indented by depth. */
function renderTree(node: Node, depth: number, out: string[]): void {
  if (out.length >= LINE_CAP) return;
  const bits = [node.role ?? "node"];
  if (node.name) bits.push(quote(node.name));
  if (node.value) bits.push(`= ${quote(node.value)}`);
  if (node.ref_id) bits.push(node.ref_id);
  if (node.states?.length) bits.push(`(${node.states.join(",")})`);
  if (node.available_actions?.length) bits.push(`{${node.available_actions.join(",")}}`);
  if (node.children_count) bits.push(`${node.children_count} children`);
  out.push(`${"  ".repeat(depth)}${bits.join(" ")}`);
  for (const child of node.children ?? []) renderTree(child, depth + 1, out);
}

function renderMatch(m: Match): string {
  const bits = [m.role ?? "node"];
  if (m.name) bits.push(quote(m.name));
  if (m.value) bits.push(`= ${quote(m.value)}`);
  if (m.ref_id) bits.push(m.ref_id);
  if (m.states?.length) bits.push(`(${m.states.join(",")})`);
  const list = (m.path ?? []).filter(Boolean);
  const where = list.length ? `  in ${truncate(list.slice(-3).join(" > "), 120)}` : "";
  return `${bits.join(" ")}${where}`;
}

/** A click or a toggle on a switch reads back as checked/unchecked; show what changed. */
function afterAction(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const disposition = (data.disposition ?? {}) as { delivery?: string; retry?: string };
  if (disposition.delivery) out.push(`disposition: ${disposition.delivery}`);
  const post = (data.post_state ?? {}) as { states?: string[]; value?: unknown };
  if (post.states?.length) out.push(`now: ${post.states.join(",")}`);
  if (post.value !== undefined && post.value !== null) out.push(`value: ${JSON.stringify(post.value)}`);
  if (disposition.delivery === "delivered_unverified") out.push("The app has not confirmed the change yet: take a fresh desktop_snapshot to check before doing anything else.");
  if (disposition.retry === "unsafe") out.push("Repeating this action could apply it twice; look before you act again.");
  return out;
}

export const desktopPlugin: PluginDef = {
  id: "desktop",
  name: "Desktop apps",
  description:
    "Reads and operates native macOS apps — System Settings, Notes, Preview and others — through the system accessibility tree. Vireo may act only in the apps you list, and every action waits for your confirmation.",
  author: "Vireo community",
  homepage: "https://agent-browser.dev/desktop",
  fields: [
    {
      key: "apps",
      label: "Apps Vireo may act in",
      type: "text",
      multiline: true,
      default: "System Settings",
      placeholder: "System Settings\nNotes\nPreview",
      help: "One app name per line, as desktop_apps prints it. Vireo can read any running app but acts only in these.",
    },
    {
      key: "binary",
      label: "agent-desktop command",
      type: "text",
      placeholder: "agent-desktop",
      help: "Installed with `npm install -g agent-desktop`. Give a full path when it is not on the node's PATH.",
    },
  ] as ConfigField[],
  create(ctx): PluginRuntime {
    const cfg = () => ctx.config<DesktopConfig>();
    const binary = () => (cfg().binary ?? "").trim() || "agent-desktop";
    const stateRoot = () => join(ctx.dir, "state");
    const allowed = () =>
      (cfg().apps ?? "")
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
    const isAllowed = (app: string) => allowed().some((a) => a.toLowerCase() === app.trim().toLowerCase());

    /** Which app each snapshot belongs to, so an action can be checked against the allowlist. */
    const snapshots = () => ctx.state.get<Record<string, string>>("snapshots") ?? {};

    function remember(snapshotId: unknown, app: string): void {
      if (typeof snapshotId !== "string" || !snapshotId) return;
      const map = snapshots();
      map[snapshotId] = app;
      const keys = Object.keys(map);
      for (const key of keys.slice(0, Math.max(0, keys.length - 50))) delete map[key];
      ctx.state.set("snapshots", map);
    }

    function appOf(ref: string): string {
      const id = /^@([A-Za-z0-9_-]+):e\d+$/.exec(ref.trim())?.[1];
      if (!id) throw new Error(`"${ref}" is not a desktop ref: they look like @s8f3k2p9:e11 and come from desktop_snapshot or desktop_find.`);
      const app = snapshots()[id];
      if (!app) throw new Error("That ref belongs to a snapshot Vireo no longer knows. Take a fresh desktop_snapshot of the app and use the refs it prints.");
      return app;
    }

    function gate(app: string): void {
      if (isAllowed(app)) return;
      const list = allowed();
      throw new Error(
        `Vireo may not act in ${app}: it may act only in ${list.length ? list.join(", ") : "no app yet"}. Add the app in Settings → Plugins → Desktop apps.`,
      );
    }

    function why(err: unknown, stderr: string, ms: number): string {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      if (!e) return "agent-desktop printed no result.";
      if (e.code === "ENOENT") return "agent-desktop is not installed on this machine: `npm install -g agent-desktop`, or set its path in Settings → Plugins → Desktop apps.";
      if (e.killed) return `agent-desktop did not answer within ${Math.round(ms / 1000)} s.`;
      const detail = String(stderr ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-3)
        .join(" ");
      return `agent-desktop failed (${e.code ?? e.message})${detail ? `: ${truncate(detail, 300)}` : ""}`;
    }

    function call(args: string[], ms: number, signal?: AbortSignal): Promise<Envelope> {
      return new Promise((resolve, reject) => {
        execFile(
          binary(),
          [...args, "--session", SESSION],
          { timeout: ms, maxBuffer: 8 << 20, signal, env: { ...process.env, AGENT_DESKTOP_HOME: stateRoot() } },
          (err, stdout, stderr) => {
            const first = String(stdout ?? "")
              .split("\n")
              .map((l) => l.trim())
              .find((l) => l.startsWith("{"));
            if (first) {
              try {
                resolve(JSON.parse(first) as Envelope);
                return;
              } catch {
                /* not the envelope: report it as a failure below */
              }
            }
            reject(new Error(why(err, String(stderr ?? ""), ms)));
          },
        );
      });
    }

    async function ok(args: string[], ms: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
      const env = await call(args, ms, signal);
      if (!env.ok) {
        const error = env.error ?? { code: "UNKNOWN", message: "agent-desktop reported a failure without details." };
        throw new Error(`${error.code}: ${error.message}${error.suggestion ? ` — ${error.suggestion}` : ""}`);
      }
      return env.data ?? {};
    }

    return {
      grants: { general: ["desktop_apps", "desktop_snapshot", "desktop_find", "desktop_get", "desktop_act"] },
      tools: [
        defineTool({
          name: "desktop_apps",
          label: "Running desktop apps",
          description: "List the GUI apps running on this machine and mark the ones Vireo may act in. Start here: the other desktop tools take an app name exactly as this prints it.",
          parameters: Type.Object({}),
          async run(_args, tctx) {
            const data = await ok(["list-apps"], 15_000, tctx.signal);
            const apps = (data.apps as { name: string; presentation?: string }[] | undefined) ?? [];
            if (!apps.length) return { text: "No GUI app is running that agent-desktop can see." };
            const lines = apps.map((a) => `${a.name}${a.presentation === "background" ? " (background)" : ""}${isAllowed(a.name) ? "  ← Vireo may act here" : ""}`);
            return { text: [`${apps.length} running:`, ...lines.sort()].join("\n") };
          },
        }),
        defineTool({
          name: "desktop_snapshot",
          label: "Look at a desktop app",
          description:
            "Read one app's window as an accessibility tree: role, name, value, states, available actions and a ref for every element. A skeleton (the default) reads three levels and marks cut containers with how many children they have — drill into one with ref. Refs go stale when the window changes, so take a fresh snapshot after acting.",
          parameters: Type.Object({
            app: Type.String({ description: 'App name as desktop_apps prints it, e.g. "System Settings".' }),
            ref: Type.Optional(Type.String({ description: "Drill into this ref's subtree instead of reading the whole app." })),
            depth: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: "Levels to read: 3 by default for a skeleton, 10 for a full read." })),
            full: Type.Optional(Type.Boolean({ description: "Read the whole tree rather than a skeleton. Much larger; prefer drilling." })),
          }),
          async run(args, tctx) {
            const cmd = ["snapshot", "-i", "--compact"];
            if (args.ref) cmd.push("--root", args.ref);
            else cmd.push("--app", args.app, ...(args.full ? [] : ["--skeleton"]));
            if (args.depth) cmd.push("--max-depth", String(args.depth));
            const data = await ok(cmd, 30_000, tctx.signal);
            const app = String(data.app ?? args.app);
            remember(data.snapshot_id, app);
            const lines: string[] = [];
            if (data.tree) renderTree(data.tree as Node, 0, lines);
            const window = (data.window ?? {}) as { title?: string };
            const head = [
              app,
              window.title ? `— ${window.title}` : "",
              `refs: ${data.ref_count ?? 0}`,
              data.complete === false ? "(partial read: raise depth on a region, or take a skeleton and drill)" : "",
            ]
              .filter(Boolean)
              .join("  ");
            return {
              text: lines.length ? `${head}\n${truncate(lines.join("\n"), TREE_CAP)}` : `${head}\nThe window has no accessible elements.`,
              source: `desktop:${app}`,
            };
          },
        }),
        defineTool({
          name: "desktop_find",
          label: "Find an element in a desktop app",
          description:
            "Search one app's accessibility tree by role, name, value or text and get refs back. Cheaper than a full snapshot when the target is known, e.g. role switch, name Wi-Fi.",
          parameters: Type.Object({
            app: Type.String({ description: "App name as desktop_apps prints it." }),
            role: Type.Optional(Type.String({ description: "Accessibility role: switch, checkbox, button, textfield, row, cell, popupbutton, …" })),
            name: Type.Optional(Type.String({ description: "Accessible name, or part of it." })),
            value: Type.Optional(Type.String({ description: "The element's value, or part of it." })),
            text: Type.Optional(Type.String({ description: "Text as a person reads it: the value of a field, else the name." })),
            exact: Type.Optional(Type.Boolean({ description: "Match exactly instead of as a substring." })),
            first: Type.Optional(Type.Boolean({ description: "Return only the first match. Use it before acting when several could match." })),
          }),
          async run(args, tctx) {
            const cmd = ["find", "--app", args.app];
            for (const flag of ["role", "name", "value", "text"] as const) {
              const v = args[flag];
              if (v) cmd.push(`--${flag}`, v);
            }
            if (args.exact) cmd.push("--exact");
            cmd.push(...(args.first ? ["--first"] : ["--limit", "20"]));
            const data = await ok(cmd, 30_000, tctx.signal);
            remember(data.snapshot_id, args.app);
            const single = data.match as Match | undefined;
            const many = (data.matches as Match[] | undefined) ?? [];
            const rows = single ? [single] : many;
            if (!rows.length) {
              const roles = (data.roles_present as string[] | undefined) ?? [];
              return {
                text: `No element in ${args.app} matches.${roles.length ? ` Roles in this window: ${roles.slice(0, 20).join(", ")}.` : ""}`,
                source: `desktop:${args.app}`,
              };
            }
            const head = `${rows.length} match${rows.length === 1 ? "" : "es"} in ${args.app}${rows.length > 1 && !args.first ? " (take a fresh find with first, or a narrower name, before acting)" : ""}:`;
            return { text: [head, ...rows.map(renderMatch)].join("\n"), source: `desktop:${args.app}` };
          },
        }),
        defineTool({
          name: "desktop_get",
          label: "Read one element's state",
          description: "Read one property of a ref: text, value, title, role, states or bounds. Use it to check that an action took effect.",
          parameters: Type.Object({
            ref: Type.String({ description: "A ref from the latest desktop_snapshot or desktop_find." }),
            property: Type.Optional(
              Type.Union([Type.Literal("text"), Type.Literal("value"), Type.Literal("title"), Type.Literal("role"), Type.Literal("states"), Type.Literal("bounds")], {
                description: "text (default) is what a person reads.",
              }),
            ),
          }),
          async run(args, tctx) {
            const property = args.property ?? "text";
            const data = await ok(["get", args.ref, "--property", property], 15_000, tctx.signal);
            return { text: `${args.ref} ${property}: ${JSON.stringify(data.value ?? null)}`, source: "desktop" };
          },
        }),
        defineTool({
          name: "desktop_act",
          label: "Act in a desktop app",
          description:
            "Act on one element of a desktop app: click, toggle, check, uncheck, set_value, type or select. Every action waits for the owner's confirmation, and only apps on the allowlist may be touched. The result says whether the app confirmed the change; take a fresh snapshot when it did not.",
          parameters: Type.Object({
            action: Type.Union(
              [
                Type.Literal("click"),
                Type.Literal("toggle"),
                Type.Literal("check"),
                Type.Literal("uncheck"),
                Type.Literal("set_value"),
                Type.Literal("type"),
                Type.Literal("select"),
              ],
              { description: "check and uncheck are idempotent; toggle flips whatever is there." },
            ),
            ref: Type.String({ description: "A ref from the latest snapshot of the app." }),
            value: Type.Optional(Type.String({ description: "The text for type and set_value, or the option for select." })),
            description: Type.String({ description: "What this does, for the owner's confirmation card: 'Turn Wi-Fi off'." }),
          }),
          confirm: () => true,
          summarize: (args) => args.description,
          async run(args, tctx) {
            const app = appOf(args.ref);
            gate(app);
            if (VALUED.includes(args.action) && !args.value) throw new Error(`${args.action.replace("_", " ")} needs a value.`);
            const cmd = [COMMAND[args.action], args.ref.trim()];
            if (args.value !== undefined) cmd.push(args.value);
            const data = await ok(cmd, 60_000, tctx.signal);
            return {
              text: [`${args.action.replace("_", " ")} in ${app}: ${args.description}`, ...afterAction(data)].join("\n"),
              display: { note: args.description, output: afterAction(data).join("\n") },
            };
          },
        }),
      ],
      async status(): Promise<PluginStatus> {
        const apps = allowed();
        const details = [
          { label: "Apps Vireo may act in", value: apps.length ? apps.join(", ") : "none yet — actions are refused" },
          { label: "Command", value: binary() },
        ];
        if (platform() !== "darwin") return { state: "error", message: `Desktop apps work on macOS only; this node runs on ${platform()}.`, details };
        try {
          const data = await ok(["status"], 15_000);
          const accessibility = ((data.permissions as { accessibility?: { state?: string } } | undefined)?.accessibility?.state ?? "unknown") as string;
          const surfaces = (data.supported_surfaces as string[] | undefined) ?? [];
          details.push({ label: "Accessibility", value: accessibility }, { label: "agent-desktop", value: String(data.version ?? "unknown") });
          if (accessibility !== "granted" || !surfaces.length) {
            return {
              state: "setup",
              message:
                "macOS has not granted Accessibility yet. In System Settings → Privacy & Security → Accessibility, add the app that runs Vireo (or agent-desktop itself), turn it on, then run `agent-desktop permissions` again.",
              details,
            };
          }
          if (!apps.length) return { state: "setup", message: "Accessibility is granted. List the apps Vireo may act in above; until then it can only look.", details };
          return { state: "ready", message: `Vireo can act in ${apps.join(", ")}.`, details };
        } catch (err) {
          return { state: "error", message: errorMessage(err), details };
        }
      },
    };
  },
};
