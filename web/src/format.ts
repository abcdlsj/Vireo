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
  list_credentials: "Checked sign-ins",
  read_file: "Read a file",
  create_file: "Created a file",
  propose_procedure: "Proposed a procedure",
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
