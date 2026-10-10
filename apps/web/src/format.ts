export function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return "now";
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h`;
  if (d < 7 * 86400_000) return `${Math.floor(d / 86400_000)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Time of day for today, otherwise the date and time. */
export function shortTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(undefined, sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const TOOL_LABELS: Record<string, string> = {
  web_search: "Searched the web",
  fetch_page: "Read a page",
  recall_memory: "Checked memory",
  remember: "Saved to memory",
  forget_memory: "Forget a memory",
  find_threads: "Looked up earlier threads",
  read_thread: "Read an earlier thread",
  open_thread: "Opened a thread",
  set_status: "Updated status",
  complete_thread: "Marked done",
  set_reminder: "Set a reminder",
  list_reminders: "Checked reminders",
  cancel_reminder: "Cancelled a reminder",
  list_events: "Read the calendar",
  find_free_slots: "Found free time",
  create_event: "Create event",
  update_event: "Move event",
  delete_event: "Cancel event",
  respond_to_invite: "Respond to invitation",
  search_email: "Searched email",
  read_email: "Read an email",
  draft_email: "Saved a draft",
  send_email: "Send email",
  browser_open: "Opened a page",
  browser_snapshot: "Looked at the page",
  browser_click: "Clicked",
  browser_type: "Typed",
  browser_select: "Chose an option",
  browser_screenshot: "Took a screenshot",
  browser_read: "Read the page",
  browser_press: "Pressed a key",
  browser_check: "Ticked a box",
  browser_hover: "Hovered",
  browser_scroll: "Scrolled",
  browser_wait: "Waited for the page",
  browser_back: "Went back",
  browser_tab: "Switched tab",
  list_credentials: "Checked sign-ins",
  read_file: "Read a file",
  create_file: "Created a file",
  propose_procedure: "Proposed a procedure",
  show_card: "Showed a card",
};

export function toolLabel(name: string): string {
  if (name.startsWith("transfer_to_")) return "Handed over";
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ");
}

/** Rewrites ISO 8601 date-times inside text as readable local times. */
export function prettyDates(text: string): string {
  return text.replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)/g, (iso) => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms)
      ? iso
      : new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  });
}

/** Token counts in millions or billions only ("0.41M", "70.3M", "1.2B"). */
export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2)}B`;
  if (n === 0) return "0M";
  if (n < 1e4) return "<0.01M";
  return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** Argument keys that say what a call was about, most telling first. */
const KEY_ARGS = ["query", "url", "command", "to", "subject", "title", "text", "description", "value", "values", "name", "machine", "file_id", "id", "date", "from"];

function oneLine(v: unknown, max = 90): string {
  const s = (typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : JSON.stringify(v)).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The one argument worth showing next to a step, e.g. the query or the URL. */
export function stepSubject(args: Record<string, unknown> | string | null | undefined): string {
  let a = args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a) as Record<string, unknown>;
    } catch {
      return oneLine(a);
    }
  }
  if (!a || typeof a !== "object") return "";
  const obj = a as Record<string, unknown>;
  if (obj.machine && obj.command) return `${oneLine(obj.command, 70)} on ${String(obj.machine)}`;
  const iso = (v: unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\d/.test(v);
  if (iso(obj.from) && iso(obj.to)) return prettyDates(`${String(obj.from)} → ${String(obj.to)}`);
  const key = KEY_ARGS.find((k) => obj[k] !== undefined && obj[k] !== "") ?? Object.keys(obj).find((k) => k !== "ref" && typeof obj[k] === "string" && obj[k] !== "");
  return key ? prettyDates(oneLine(obj[key])) : "";
}

/** A short, readable outcome of a step: the first meaningful line of its result. */
export function stepOutcome(text: string | null | undefined): string {
  if (!text) return "";
  const clean = text.replace(/^Not executed yet: this needs the owner's confirmation[\s\S]*$/, "Waiting for your confirmation");
  const results = clean.match(/^\d+\. /gm)?.length;
  if (results && results > 1) return `${results} results`;
  const lines = clean
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(Title|URL):\s*$/.test(l));
  const first = lines[0];
  if (!first) return "";
  // "Free slots (…):" followed by a list reads better as a count.
  if (first.endsWith(":") && lines.length > 1) return prettyDates(oneLine(`${first.slice(0, -1)} · ${lines.length - 1} listed`, 140));
  return prettyDates(oneLine(first, 140));
}

/** Names for model-call purposes in the activity list. */
export function purposeLabel(purpose: string, agent: string | null): string {
  if (purpose === "agent") return agent ? `${agent[0]!.toUpperCase()}${agent.slice(1)} agent` : "Agent";
  const names: Record<string, string> = { thread_title: "Named the thread", memory_extract: "Memory upkeep", memory_distill: "Distilled the thread", summary: "Summary" };
  return names[purpose] ?? purpose.replace(/_/g, " ");
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "…";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** Counts as 812, 7.4k, 1.2M. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
}
