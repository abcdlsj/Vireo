import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool } from "../../tools/types.js";
import type { Risk } from "../../tools/types.js";
import { errorMessage, truncate } from "../../util.js";
import type { ConfigField, PluginDef, PluginRuntime, PluginStatus } from "../types.js";

/**
 * Desktop apps: Vireo reads and operates native macOS apps through the
 * system accessibility tree, with agent-desktop (vercel-labs) doing the
 * reading and the acting. A desktop action is not confined to one window the
 * way a browser tab is, so every action is confirmed and only the apps the
 * owner listed may be touched.
 *
 * Two things about a real desktop shape this file around: an app can have
 * several windows, and reading or acting on "the app" is then refused by
 * agent-desktop (AMBIGUOUS_TARGET); and an app that is running in the
 * background may present no window at all (WINDOW_NOT_FOUND). Both used to be
 * dead ends for the model, which then repeated the same failing call. Vireo
 * now resolves them itself: the focused window of a remembered app, or the
 * app brought forward.
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
  data?: unknown;
  error?: { code: string; message: string; suggestion?: string; details?: Record<string, unknown> };
}

interface WindowRow {
  id?: string;
  title?: string;
  app_name?: string;
  bounds?: { x?: number; y?: number; width?: number; height?: number };
  is_focused?: boolean;
  minimized?: boolean;
  visible?: boolean;
  accessible?: boolean;
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

/** How long a call gets: a snapshot of a big app is slow, an action slower. */
const STAT_MS = 15_000;
const TREE_MS = 30_000;
const ACT_MS = 60_000;
const LAUNCH_MS = 30_000;

/**
 * How long a read retries while the app rebuilds its window: macOS drops and
 * rebuilds a settings window's tree while a pane changes. Past that the app
 * really has no window, and Vireo asks it to present one (below).
 */
const READ_WAIT_MS = 2_000;
const AFTER_ACTIVATE_MS = 5_000;

/** An app between windows: reading again is safe, only writes are not. */
const TRANSIENT = new Set(["WINDOW_NOT_FOUND", "APP_NOT_FOUND"]);

/**
 * Element names that mean the click does something the owner cannot undo or would
 * want to see: deleting, paying, quitting. Words are matched on the visible label,
 * which is what a person reads before clicking.
 */
const IRREVERSIBLE = /\b(delete|erase|discard|remove|reset|quit|sign out|log out|uninstall|revoke|empty|clear all)\b|删除|移除|清空|重置|注销|退出登录|卸载|解绑|撤销授权|退出群/i;
/** Outward but recoverable: sending, submitting, buying, publishing, inviting. */
const OUTWARD = /\b(send|submit|pay|purchase|buy|order|checkout|book|reserve|share|publish|post|invite|approve|transfer)\b|发送|提交|支付|付款|购买|下单|预订|预定|发布|分享|转发|邀请|审批|转账/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The envelope, when a command printed one. */
function parse(text: string): Envelope | undefined {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("{"));
  if (!line) return undefined;
  try {
    return JSON.parse(line) as Envelope;
  } catch {
    return undefined;
  }
}

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

/** One window as the model reads it. */
function renderWindow(w: WindowRow): string {
  const bits = [w.id ?? "(no id)"];
  bits.push(w.title ? quote(w.title) : "(untitled)");
  if (w.app_name) bits.push(`in ${w.app_name}`);
  if (w.is_focused) bits.push("(focused)");
  if (w.minimized) bits.push("(minimized)");
  if (w.visible === false) bits.push("(hidden)");
  if (w.accessible === false) bits.push("(not readable through accessibility)");
  const b = w.bounds;
  if (b && b.width && b.height) bits.push(`${Math.round(b.width)}×${Math.round(b.height)} at ${Math.round(b.x ?? 0)},${Math.round(b.y ?? 0)}`);
  return bits.join(" ");
}

/** A click or a toggle on a switch reads back as checked/unchecked; show what changed. */
function afterAction(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const disposition = (data.disposition ?? {}) as { delivery?: string; retry?: string };
  if (disposition.delivery) out.push(`disposition: ${disposition.delivery}`);
  const post = (data.post_state ?? {}) as { states?: string[]; value?: unknown };
  if (post.states?.length) out.push(`now: ${post.states.join(",")}`);
  if (post.value !== undefined && post.value !== null) out.push(`value: ${JSON.stringify(post.value)}`);
  if (disposition.delivery === "delivered_unverified") out.push("The app has not confirmed the change yet: the window below is read fresh, so check it before doing anything else.");
  if (disposition.retry === "unsafe") out.push("Repeating this action could apply it twice; look before you act again.");
  return out;
}

/** A confirmation card is only worth reading if it shows what will be written. */
function withValue(description: string, value?: string): string {
  if (!value) return description;
  const one = value.replace(/\s+/g, " ").trim();
  return one ? `${description}: “${truncate(one, 120)}”` : description;
}

/** What the model should do about a failure, in Vireo's own tools — never in CLI flags it cannot run. */
function hint(code: string, app?: string): string {
  switch (code) {
    case "AMBIGUOUS_TARGET":
      return `More than one window or app instance matches${app ? ` ${app}` : ""}: call desktop_windows${app ? ` with app "${app}"` : ""}, then pass the id it prints as window_id.`;
    case "STALE_REF":
      return "The element is gone or no longer matches: take a fresh desktop_snapshot of the app and act on the refs it prints.";
    case "SNAPSHOT_NOT_FOUND":
      return "That snapshot expired: take a fresh desktop_snapshot.";
    case "TIMEOUT":
      return "The read did not settle in time: pass the window_id from desktop_windows, narrow the search with desktop_find (role and first), or raise timeout_ms.";
    case "WINDOW_NOT_FOUND":
      return "The app has no window open. Vireo brings an app on the list forward by itself; if this one is not on it, add the app in Settings → Plugins → Desktop apps, or open its window.";
    case "APP_NOT_FOUND":
      return "That app is not running: desktop_apps lists the ones that are.";
    case "POLICY_DENIED":
      return "The system refused this: the shortcut is one macOS blocks, or the surface needs a permission Vireo does not have.";
    case "ACTION_NOT_SUPPORTED":
      return "That element does not offer this action. Act on another element, or send a key combination with desktop_press.";
    default:
      return "";
  }
}

export const desktopPlugin: PluginDef = {
  id: "desktop",
  name: "Desktop apps",
  description:
    "Reads and operates native macOS apps — System Settings, Notes, Preview and others — through the system accessibility tree. Vireo may act only in the apps you list; reading and navigating happen at once, outward actions wait for your confirmation.",
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

    /**
     * launchd starts a job with a bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
     * so a name like `agent-desktop` resolves to nothing and the job dies
     * silently. Resolve the command here, where the node's own PATH applies.
     */
    function command(): string {
      const given = binary();
      if (given.includes("/")) return given;
      const dirs = [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean);
      for (const dir of dirs) if (existsSync(join(dir, given))) return join(dir, given);
      throw new Error(`${given} is not installed on this machine: \`npm install -g agent-desktop\`, or set its path in Settings → Plugins → Desktop apps.`);
    }
    const allowed = () =>
      (cfg().apps ?? "")
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
    const isAllowed = (app: string) => allowed().some((a) => a.toLowerCase() === app.trim().toLowerCase());

    /** Which app each snapshot belongs to, so an action can be checked against the allowlist. */
    const snapshots = () => ctx.state.get<Record<string, string>>("snapshots") ?? {};

    /**
     * What each ref is called, as the app presents it. A word like "삭제" or
     * "发送" is the only clue an element's action is outward, so the name is kept
     * from the read that produced the ref; an unknown ref is treated as risky.
     */
    const elements = () => ctx.state.get<Record<string, { role?: string; name?: string }>>("elements") ?? {};

    function rememberElements(found: { ref_id?: string; role?: string; name?: string }[]): void {
      const map = elements();
      for (const el of found) if (el.ref_id) map[el.ref_id] = { role: el.role, name: el.name };
      const keys = Object.keys(map);
      for (const key of keys.slice(0, Math.max(0, keys.length - 600))) delete map[key];
      ctx.state.set("elements", map);
    }

    function collectElements(node: Node): { ref_id?: string; role?: string; name?: string }[] {
      const out: { ref_id?: string; role?: string; name?: string }[] = [];
      const walk = (n: Node) => {
        if (n.ref_id) out.push({ ref_id: n.ref_id, role: n.role, name: n.name });
        for (const child of n.children ?? []) walk(child);
      };
      walk(node);
      return out;
    }

    /** How much attention a click, toggle or selection needs, from the element's own label. */
    function elementRisk(ref: string): Risk {
      const name = (elements()[ref.trim()]?.name ?? "").trim();
      if (!name) return "ask";
      if (IRREVERSIBLE.test(name)) return "always";
      if (OUTWARD.test(name)) return "ask";
      // A named row, tab or menu item that says nothing outward is navigation.
      return "none";
    }

    function remember(snapshotId: unknown, app: string): void {
      if (typeof snapshotId !== "string" || !snapshotId) return;
      const map = snapshots();
      map[snapshotId] = app;
      const keys = Object.keys(map);
      for (const key of keys.slice(0, Math.max(0, keys.length - 50))) delete map[key];
      ctx.state.set("snapshots", map);
    }

    /** The window Vireo last used for each app, so a later call lands in the same one. */
    const windowIds = () => ctx.state.get<Record<string, string>>("windows") ?? {};

    function rememberWindow(app: string, id: string | undefined): void {
      const map = windowIds();
      if (id) map[app] = id;
      else delete map[app];
      ctx.state.set("windows", map);
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

    /**
     * macOS hands the Accessibility grant to the process that starts the CLI,
     * not to the CLI itself. Vireo's node is itself started by launchd, so a
     * plain child of it inherits node's identity, and node holds no grant. A
     * one-shot launchd job runs the CLI as its own program: the grant lands on
     * agent-desktop alone, and nothing else on this machine — no node script, no
     * coding agent's shell command — gains control of the desktop.
     */
    async function runAsJob(argv: string[], ms: number, signal?: AbortSignal): Promise<string> {
      const dir = join(ctx.dir, "calls");
      mkdirSync(dir, { recursive: true });
      const id = randomUUID();
      const label = `com.vireo.desktop.${id}`;
      const out = join(dir, `${id}.json`);
      const err = join(dir, `${id}.err`);
      try {
        await new Promise<void>((resolve, reject) => {
          execFile("/bin/launchctl", ["submit", "-l", label, "-o", out, "-e", err, "--", command(), ...argv], { timeout: 20_000, signal }, (e, _stdout, stderr) =>
            e ? reject(new Error(`launchctl could not start agent-desktop: ${String(stderr ?? "").trim() || e.message}`)) : resolve(),
          );
        });
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (signal?.aborted) throw new Error("The action was cancelled.");
          if (existsSync(out)) {
            const text = readFileSync(out, "utf8");
            if (parse(text)) return text;
          }
          await sleep(150);
        }
        const detail = existsSync(err) ? readFileSync(err, "utf8").trim() : "";
        const silent = detail ? "" : " The job printed nothing: check that the command runs by itself.";
        throw new Error(`agent-desktop did not answer within ${Math.round(ms / 1000)} s.${detail ? ` ${truncate(detail, 300)}` : ""}${silent}`);
      } finally {
        execFile("/bin/launchctl", ["remove", label], () => undefined);
        rmSync(out, { force: true });
        rmSync(err, { force: true });
      }
    }

    function call(args: string[], ms: number, signal?: AbortSignal): Promise<Envelope> {
      return new Promise((resolve, reject) => {
        const argv = [...args, "--session", SESSION];
        const receive = (text: string) => {
          const env = parse(text);
          if (env) resolve(env);
          else reject(new Error("agent-desktop printed no result."));
        };
        if (process.env.VIREO_DESKTOP_SPAWN === "direct") {
          execFile(command(), argv, { timeout: ms, maxBuffer: 8 << 20, signal }, (err, stdout, stderr) => {
            if (parse(String(stdout ?? ""))) receive(String(stdout ?? ""));
            else reject(new Error(why(err, String(stderr ?? ""), ms)));
          });
          return;
        }
        runAsJob(argv, ms, signal).then(receive, reject);
      });
    }

    /** What the node resolved the command to, or why it could not. */
    function safeCommand(): string {
      try {
        return command();
      } catch (err) {
        return errorMessage(err);
      }
    }

    const failure = (env: Envelope) => env.error ?? { code: "UNKNOWN", message: "agent-desktop reported a failure without details." };

    /** A failure as the model reads it: the cause, the windows that are open, and what to do in Vireo's tools. */
    function fail(env: Envelope, app?: string): Error {
      const e = failure(env);
      const ids = (e.details ?? {}).candidate_window_ids;
      const candidates = Array.isArray(ids) ? ids.filter((id) => typeof id === "string").slice(0, 6) : [];
      const parts = [`${e.code}: ${e.message}`];
      if (candidates.length) parts.push(`Windows open: ${candidates.join(", ")}.`);
      const advice = hint(e.code, app) || truncate(e.suggestion ?? "", 300);
      if (advice) parts.push(advice);
      return new Error(parts.join(" "));
    }

    async function ok(args: string[], ms: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
      const env = await call(args, ms, signal);
      if (!env.ok) throw fail(env);
      return (env.data ?? {}) as Record<string, unknown>;
    }

    /** The windows of one app (or all of them). */
    async function listWindows(app: string | undefined, signal?: AbortSignal): Promise<WindowRow[]> {
      const env = await call(app ? ["list-windows", "--app", app] : ["list-windows"], STAT_MS, signal);
      if (!env.ok) throw fail(env, app);
      return Array.isArray(env.data) ? (env.data.filter((w) => w && typeof w === "object") as WindowRow[]) : [];
    }

    /**
     * Which window of a many-window app a call should land in: the one holding
     * focus, else the only readable one, else — for an app Vireo may act in —
     * the first readable one, brought forward so keys and semantic reads land
     * in it. Anything less certain is left to the model, with the ids.
     */
    async function chooseWindow(app: string, signal: AbortSignal | undefined, rows?: WindowRow[]): Promise<string | undefined> {
      const all = rows ?? (await listWindows(app, signal));
      const withId = all.filter((w) => w.id);
      if (!withId.length) return undefined;
      const focused = withId.find((w) => w.is_focused && w.accessible !== false) ?? withId.find((w) => w.is_focused);
      if (focused?.id) return focused.id;
      const readable = withId.filter((w) => w.accessible !== false && w.visible !== false);
      if (readable.length === 1) return readable[0]!.id;
      if (!isAllowed(app) || !readable.length) return undefined;
      const pick = readable[0]!;
      const env = await call(["focus-window", "--window-id", pick.id!], STAT_MS, signal);
      return env.ok ? pick.id : undefined;
    }

    /** The window to send keys to: the remembered one, the only one, or one brought forward. */
    async function targetWindow(app: string, signal?: AbortSignal): Promise<string | undefined> {
      const known = windowIds()[app];
      if (known) return known;
      const id = await chooseWindow(app, signal);
      if (id) rememberWindow(app, id);
      return id;
    }

    /**
     * Make an app able to take keys: its window active, or its window opened.
     * agent-desktop sends keys physically, so a scoped press into a background
     * window is refused rather than delivered to the wrong place.
     */
    async function bringForward(app: string, windowId: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
      if (windowId) {
        const focused = await call(["focus-window", "--window-id", windowId], STAT_MS, signal);
        if (focused.ok) return windowId;
      }
      const launched = await call(["launch", app, "--activate", "--timeout", "20000"], LAUNCH_MS, signal);
      if (!launched.ok) return windowId;
      return windowId ?? (await targetWindow(app, signal));
    }

    interface ReadOptions {
      app?: string;
      signal?: AbortSignal;
      /** Keep polling while the app rebuilds its window (macOS does this when a pane changes). */
      transient?: boolean;
      /** Land the call in one window of the app, resolving several windows itself. */
      scope?: boolean;
      ms?: number;
    }

    interface ReadResult {
      data: Record<string, unknown>;
      /** What Vireo did to make the read possible, so the model can say so. */
      notes: string[];
    }

    /**
     * A read, made to survive a real desktop: a window that is briefly gone is
     * waited out, an app with no window is brought forward, and an app with
     * several windows gets the focused one instead of AMBIGUOUS_TARGET.
     */
    async function read(args: string[], opts: ReadOptions = {}): Promise<ReadResult> {
      const { app, signal, transient = true, scope = true, ms = TREE_MS } = opts;
      const notes: string[] = [];
      let cmd = [...args];
      const scoped = () => cmd.includes("--window-id");
      const forgetWindow = () => {
        if (!app) return;
        rememberWindow(app, undefined);
        const at = cmd.indexOf("--window-id");
        if (at >= 0) cmd = [...cmd.slice(0, at), ...cmd.slice(at + 2)];
      };
      if (app && scope && !scoped()) {
        const known = windowIds()[app];
        if (known) cmd.push("--window-id", known);
      }
      let askedWindow = false;
      let activated = false;
      let deadline = Date.now() + READ_WAIT_MS;
      for (let attempt = 0; attempt < 40; attempt++) {
        const env = await call(cmd, ms, signal);
        if (env.ok) return { data: (env.data ?? {}) as Record<string, unknown>, notes };
        const e = failure(env);
        // The remembered window closed: look at whatever is open now.
        if (e.code === "WINDOW_NOT_FOUND" && scoped()) {
          forgetWindow();
          deadline = Date.now() + READ_WAIT_MS;
          continue;
        }
        if (transient && TRANSIENT.has(e.code) && Date.now() < deadline) {
          await sleep(300);
          if (signal?.aborted) throw new Error("The read was cancelled.");
          continue;
        }
        if (e.code === "AMBIGUOUS_TARGET" && app && scope && !scoped() && !askedWindow) {
          askedWindow = true;
          const id = await chooseWindow(app, signal);
          if (id) {
            rememberWindow(app, id);
            notes.push(`Several windows matched; used ${id}.`);
            cmd.push("--window-id", id);
            continue;
          }
        }
        if (e.code === "WINDOW_NOT_FOUND" && app && !activated && isAllowed(app)) {
          activated = true;
          const env2 = await call(["launch", app, "--activate", "--timeout", "20000"], LAUNCH_MS, signal);
          if (env2.ok) {
            notes.push(`Brought ${app} forward: it was running with no window.`);
            deadline = Date.now() + AFTER_ACTIVATE_MS;
            continue;
          }
        }
        throw fail(env, app);
      }
      throw new Error(`${app ?? "The app"} did not become readable. Take a fresh desktop_snapshot, or check it on screen.`);
    }

    /** The app's window as the model reads it, plus its refs. */
    async function look(app: string, signal?: AbortSignal, depth?: number): Promise<{ text: string; notes: string[]; snapshotId?: string }> {
      const cmd = ["snapshot", "-i", "--compact", "--app", app];
      if (depth) cmd.push("--max-depth", String(depth));
      else cmd.push("--skeleton");
      const { data, notes } = await read(cmd, { app, signal });
      const owner = String(data.app ?? app);
      remember(data.snapshot_id, owner);
      const lines: string[] = [];
      if (data.tree) {
        rememberElements(collectElements(data.tree as Node));
        renderTree(data.tree as Node, 0, lines);
      }
      const window = (data.window ?? {}) as { title?: string };
      const head = [owner, window.title ? `— ${window.title}` : "", `refs: ${data.ref_count ?? 0}`, data.complete === false ? "(partial read: drill into a region)" : ""]
        .filter(Boolean)
        .join("  ");
      return { text: `${head}\n${truncate(lines.join("\n"), TREE_CAP)}`, notes, snapshotId: typeof data.snapshot_id === "string" ? data.snapshot_id : undefined };
    }

    return {
      grants: {
        general: ["desktop_apps", "desktop_windows", "desktop_snapshot", "desktop_find", "desktop_get", "desktop_act", "desktop_press", "desktop_wait"],
      },
      tools: [
        defineTool({
          name: "desktop_apps",
          label: "Running desktop apps",
          description: "List the GUI apps running on this machine and mark the ones Vireo may act in. Start here: the other desktop tools take an app name exactly as this prints it.",
          parameters: Type.Object({}),
          async run(_args, tctx) {
            const data = await ok(["list-apps"], STAT_MS, tctx.signal);
            const apps = (data.apps as { name: string; presentation?: string }[] | undefined) ?? [];
            if (!apps.length) return { text: "No GUI app is running that agent-desktop can see." };
            const lines = apps.map((a) => `${a.name}${a.presentation === "background" ? " (background)" : ""}${isAllowed(a.name) ? "  ← Vireo may act here" : ""}`);
            return { text: [`${apps.length} running:`, ...lines.sort()].join("\n") };
          },
        }),
        defineTool({
          name: "desktop_windows",
          label: "Windows of a desktop app",
          description:
            "List the windows of an app, or of every app, with the id of each. Call it when an app has several windows: desktop_snapshot, desktop_find and desktop_press take one of these ids as window_id, and Vireo otherwise uses the focused window.",
          parameters: Type.Object({
            app: Type.Optional(Type.String({ description: 'App name as desktop_apps prints it. Leave it out to list every window.' })),
          }),
          async run(args, tctx) {
            const rows = await listWindows(args.app, tctx.signal);
            if (!rows.length) return { text: args.app ? `${args.app} has no window open.` : "No window is open on screen.", source: "desktop" };
            const head = `${rows.length} window${rows.length === 1 ? "" : "s"}${args.app ? ` of ${args.app}` : ""}:`;
            const current = args.app ? windowIds()[args.app] : undefined;
            const lines = rows.map((w) => `${renderWindow(w)}${w.id && w.id === current ? "  ← Vireo will use this one" : ""}`);
            return { text: [head, ...lines].join("\n"), source: "desktop" };
          },
        }),
        defineTool({
          name: "desktop_snapshot",
          label: "Look at a desktop app",
          description:
            "Read one app's window as an accessibility tree: role, name, value, states, available actions and a ref for every element. A skeleton (the default) reads three levels and marks cut containers with how many children they have — drill into one with ref. desktop_act already returns the window as it is afterwards, so a separate snapshot is only needed when something else changed it.",
          parameters: Type.Object({
            app: Type.String({ description: 'App name as desktop_apps prints it, e.g. "System Settings".' }),
            window_id: Type.Optional(Type.String({ description: "One window id from desktop_windows, when the app has several windows." })),
            ref: Type.Optional(Type.String({ description: "Drill into this ref's subtree instead of reading the whole app." })),
            depth: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: "Levels to read: 3 by default for a skeleton, 10 for a full read." })),
            full: Type.Optional(Type.Boolean({ description: "Read the whole tree rather than a skeleton. Much larger; prefer drilling." })),
          }),
          async run(args, tctx) {
            if (args.window_id) rememberWindow(args.app, args.window_id);
            if (!args.ref) {
              const cmd = ["snapshot", "-i", "--compact", "--app", args.app];
              if (args.window_id) cmd.push("--window-id", args.window_id);
              if (args.depth) cmd.push("--max-depth", String(args.depth));
              else if (!args.full) cmd.push("--skeleton");
              const { data, notes } = await read(cmd, { app: args.app, signal: tctx.signal });
              const owner = String(data.app ?? args.app);
              remember(data.snapshot_id, owner);
              const lines: string[] = [];
              if (data.tree) {
                rememberElements(collectElements(data.tree as Node));
                renderTree(data.tree as Node, 0, lines);
              }
              const window = (data.window ?? {}) as { title?: string };
              const head = [owner, window.title ? `— ${window.title}` : "", `refs: ${data.ref_count ?? 0}`, data.complete === false ? "(partial read: drill into a region)" : ""]
                .filter(Boolean)
                .join("  ");
              const text = notes.length ? `${notes.join(" ")}\n${head}\n${truncate(lines.join("\n"), TREE_CAP)}` : `${head}\n${truncate(lines.join("\n"), TREE_CAP)}`;
              return { text, source: `desktop:${args.app}` };
            }
            const cmd = ["snapshot", "-i", "--compact", "--root", args.ref];
            if (args.depth) cmd.push("--max-depth", String(args.depth));
            // A drill into a dead window gets nowhere by waiting: one read only.
            const { data } = await read(cmd, { signal: tctx.signal, transient: false });
            const app = String(data.app ?? snapshots()[/^@([A-Za-z0-9_-]+):/.exec(args.ref)?.[1] ?? ""] ?? args.app);
            remember(data.snapshot_id, app);
            const lines: string[] = [];
            if (data.tree) {
              rememberElements(collectElements(data.tree as Node));
              renderTree(data.tree as Node, 0, lines);
            }
            const head = [app, `refs: ${data.ref_count ?? 0}`].join("  ");
            return {
              text: lines.length ? `${head}\n${truncate(lines.join("\n"), TREE_CAP)}` : `${head}\nThat region has no accessible elements.`,
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
            window_id: Type.Optional(Type.String({ description: "One window id from desktop_windows, when the app has several windows." })),
            role: Type.Optional(Type.String({ description: "Accessibility role: switch, checkbox, button, textfield, row, cell, popupbutton, …" })),
            name: Type.Optional(Type.String({ description: "Accessible name, or part of it." })),
            value: Type.Optional(Type.String({ description: "The element's value, or part of it." })),
            text: Type.Optional(Type.String({ description: "Text as a person reads it: the value of a field, else the name." })),
            root: Type.Optional(Type.String({ description: "Search only inside this ref's subtree — the way to keep a search in one list or pane." })),
            exact: Type.Optional(Type.Boolean({ description: "Match exactly instead of as a substring." })),
            first: Type.Optional(Type.Boolean({ description: "Return only the first match. Use it before acting when several could match." })),
            timeout_ms: Type.Optional(Type.Number({ minimum: 1_000, maximum: 120_000, description: "How long the search may take: 30 s by default, raise it for a very large tree." })),
          }),
          async run(args, tctx) {
            const cmd = ["find", "--app", args.app];
            if (args.window_id) {
              cmd.push("--window-id", args.window_id);
              rememberWindow(args.app, args.window_id);
            }
            if (args.root) cmd.push("--root", args.root);
            if (args.timeout_ms) cmd.push("--timeout-ms", String(args.timeout_ms));
            for (const flag of ["role", "name", "value", "text"] as const) {
              const v = args[flag];
              if (v) cmd.push(`--${flag}`, v);
            }
            if (args.exact) cmd.push("--exact");
            cmd.push(...(args.first ? ["--first"] : ["--limit", "20"]));
            const { data, notes } = await read(cmd, { app: args.app, signal: tctx.signal, ms: args.timeout_ms ?? TREE_MS });
            remember(data.snapshot_id, args.app);
            const single = data.match as Match | undefined;
            const many = (data.matches as Match[] | undefined) ?? [];
            const rows = single ? [single] : many;
            rememberElements(rows);
            const lead = notes.length ? `${notes.join(" ")}\n` : "";
            if (!rows.length) {
              const roles = (data.roles_present as string[] | undefined) ?? [];
              return {
                text: `${lead}No element in ${args.app} matches.${roles.length ? ` Roles in this window: ${roles.slice(0, 20).join(", ")}.` : ""}`,
                source: `desktop:${args.app}`,
              };
            }
            const head = `${rows.length} match${rows.length === 1 ? "" : "es"} in ${args.app}${rows.length > 1 && !args.first ? " (take a fresh find with first, or a narrower name, before acting)" : ""}:`;
            return { text: `${lead}${[head, ...rows.map(renderMatch)].join("\n")}`, source: `desktop:${args.app}` };
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
            const { data } = await read(["get", args.ref, "--property", property], { signal: tctx.signal, transient: false, scope: false, ms: STAT_MS });
            const v = data.value ?? null;
            const empty = v === null || v === "" || (Array.isArray(v) && !v.length);
            const note = empty && property !== "bounds" ? " (nothing set; try another property, or read the window)" : "";
            return { text: `${args.ref} ${property}: ${JSON.stringify(v)}${note}`, source: "desktop" };
          },
        }),
        defineTool({
          name: "desktop_act",
          label: "Act in a desktop app",
          description:
            "Act on one element of a desktop app: click, toggle, check, uncheck, set_value, type or select. Filling a field and clicking a named row, tab or menu item happen at once; an unnamed control or one whose label says send, submit, delete or pay waits for the owner's confirmation, and only apps on the allowlist may be touched. It returns the window as it is afterwards, with fresh refs, so work from that instead of taking another snapshot. Leave the app and its windows as the change left them: do not close or tidy up. There is no keyboard action here: a shortcut such as cmd+enter is desktop_press.",
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
          confirm: (args) => {
            // Typing into a field is not outward: it goes away by typing again.
            if (args.action === "set_value" || args.action === "type") return "none";
            return elementRisk(args.ref);
          },
          summarize: (args) => (VALUED.includes(args.action) ? withValue(args.description, args.value) : args.description),
          async run(args, tctx) {
            const app = appOf(args.ref);
            gate(app);
            if (VALUED.includes(args.action) && !args.value) throw new Error(`${args.action.replace("_", " ")} needs a value.`);
            const cmd = [COMMAND[args.action], args.ref.trim()];
            if (args.value !== undefined) cmd.push(args.value);
            const data = await ok(cmd, ACT_MS, tctx.signal);
            const report = afterAction(data);
            let seen: string;
            try {
              const looked = await look(app, tctx.signal);
              seen = [looked.notes.join(" "), looked.text].filter(Boolean).join("\n");
            } catch (err) {
              seen = `The window could not be read afterwards: ${errorMessage(err)}`;
            }
            return {
              text: [`${args.action.replace("_", " ")} in ${app}: ${args.description}`, ...report, "", seen].join("\n"),
              source: `desktop:${app}`,
              display: { note: args.description, output: report.join("\n") },
            };
          },
        }),
        defineTool({
          name: "desktop_press",
          label: "Press keys in a desktop app",
          description:
            "Send a key combination to an app: cmd+enter to send a message in 企业微信, WeChat, Slack or Feishu, cmd+s to save, escape to close a menu, tab to move on. This is how a shortcut is pressed — typing text is desktop_act type or set_value. Every press waits for the owner's confirmation, and only apps on the allowlist may be targeted.",
          parameters: Type.Object({
            keys: Type.String({ description: "The combo: cmd+enter, escape, cmd+shift+z, return, tab. Modifiers cmd, ctrl, alt and shift join with +." }),
            app: Type.String({ description: "App name as desktop_apps prints it: which app the keys go to." }),
            window_id: Type.Optional(Type.String({ description: "One window id from desktop_windows, when the app has several windows." })),
            description: Type.String({ description: "What this does, for the owner's confirmation card: 'Send the message in 干饭'." }),
          }),
          confirm: (args) => {
            const parts = args.keys.trim().toLowerCase().split("+");
            const key = parts.at(-1) ?? "";
            // A chord can do anything a menu can; a bare navigation key does nothing outward.
            if (parts.length > 1) return "ask";
            if (key === "return" || key === "enter" || key === "delete" || key === "backspace") return "ask";
            if (/^(escape|tab|space|up|down|left|right|home|end|pageup|pagedown|f\d{1,2})$/.test(key)) return "none";
            return "ask";
          },
          summarize: (args) => `${args.description} (${args.keys})`,
          async run(args, tctx) {
            const app = args.app.trim();
            gate(app);
            const combo = args.keys.trim().replace(/\s+/g, "");
            if (!combo) throw new Error("press needs the keys to send, e.g. cmd+enter.");
            if (args.window_id) rememberWindow(app, args.window_id);
            const send = async (windowId: string | undefined) => {
              const cmd = ["press", combo, "--app", app];
              if (windowId) cmd.push("--window-id", windowId);
              return ok(cmd, ACT_MS, tctx.signal);
            };
            let data: Record<string, unknown>;
            const notes: string[] = [];
            const id = args.window_id ?? (await targetWindow(app, tctx.signal));
            try {
              data = await send(id);
            } catch (err) {
              const message = errorMessage(err);
              // Only retry what provably was not delivered: a press that may have
              // landed must not be sent again.
              if (!/\b(ACTION_FAILED|WINDOW_NOT_FOUND|AMBIGUOUS_TARGET)\b/.test(message)) throw err;
              const ready = await bringForward(app, id, tctx.signal);
              if (!ready) throw err;
              notes.push(`Brought ${app} forward and used window ${ready}.`);
              data = await send(ready);
            }
            const report = afterAction(data);
            let seen: string;
            try {
              const looked = await look(app, tctx.signal);
              seen = [looked.notes.join(" "), looked.text].filter(Boolean).join("\n");
            } catch (err) {
              seen = `The window could not be read afterwards: ${errorMessage(err)}`;
            }
            return {
              text: [...notes, `pressed ${combo} in ${app}: ${args.description}`, ...report, "", seen].filter(Boolean).join("\n"),
              source: `desktop:${app}`,
              display: { note: `${args.description} (${combo})`, output: report.join("\n") },
            };
          },
        }),
        defineTool({
          name: "desktop_wait",
          label: "Wait for a desktop app",
          description:
            "Wait for something in an app instead of re-reading it in a loop: a pause in milliseconds, text appearing, or a window opening. It answers whether it happened, so a step can be checked before the owner is told it worked.",
          parameters: Type.Object({
            app: Type.Optional(Type.String({ description: "App to watch, as desktop_apps prints it." })),
            ms: Type.Optional(Type.Number({ minimum: 1, maximum: 60_000, description: "Pause this many milliseconds." })),
            text: Type.Optional(Type.String({ description: "Wait until this text appears in the app's accessibility tree." })),
            window_title: Type.Optional(Type.String({ description: "Wait until a window with this title appears; part of the title matches." })),
            timeout_ms: Type.Optional(Type.Number({ minimum: 500, maximum: 120_000, description: "How long to wait for text or a window: 30 s by default." })),
          }),
          async run(args, tctx) {
            if (!args.ms && !args.text && !args.window_title) throw new Error("desktop_wait needs ms, text or window_title.");
            if (args.text && args.window_title) throw new Error("desktop_wait waits for text or for a window, not both.");
            const timeout = args.timeout_ms ?? 30_000;
            const cmd = ["wait"];
            if (args.app) cmd.push("--app", args.app);
            let what: string;
            if (args.text) {
              cmd.push("--text", args.text, "--timeout", String(timeout));
              what = `the text ${quote(args.text)}`;
            } else if (args.window_title) {
              cmd.push("--window", args.window_title, "--timeout", String(timeout));
              what = `a window titled ${quote(args.window_title)}`;
            } else {
              const ms = Math.round(args.ms!);
              cmd.push(String(ms));
              what = `${ms} ms`;
            }
            const env = await call(cmd, timeout + 15_000, tctx.signal);
            const source = args.app ? `desktop:${args.app}` : undefined;
            // Not seeing it in time is an answer, not a failure: the step did not happen, so say so.
            if (!env.ok) {
              if (env.error?.code === "TIMEOUT") {
                return { text: `${what} did not appear within ${Math.round(timeout / 1000)} s.`, details: { found: false }, source };
              }
              throw fail(env, args.app);
            }
            const data = (env.data ?? {}) as Record<string, unknown>;
            const found = data.found === false || data.timed_out === true ? "not found" : "found";
            const rest = Object.keys(data).filter((k) => !["found", "timed_out", "snapshot_id"].includes(k));
            const detail = rest.length ? ` (${truncate(JSON.stringify(Object.fromEntries(rest.map((k) => [k, data[k]]))), 300)})` : "";
            return { text: `Waited for ${what}: ${found}${detail}`, details: { ...data, found: data.found ?? true }, source };
          },
        }),
      ],
      async status(): Promise<PluginStatus> {
        const apps = allowed();
        const details = [
          { label: "Apps Vireo may act in", value: apps.length ? apps.join(", ") : "none yet — actions are refused" },
          { label: "Command", value: safeCommand() },
        ];
        if (platform() !== "darwin") return { state: "error", message: `Desktop apps work on macOS only; this node runs on ${platform()}.`, details };
        try {
          const data = await ok(["status"], STAT_MS);
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
