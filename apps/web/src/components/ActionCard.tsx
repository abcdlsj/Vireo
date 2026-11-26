import { useState } from "react";
import { api, type Action } from "../api";
import { BROWSER_HIDDEN_ARGS, browserPage, isBrowserTool, prettyDates, toolLabel, unframe } from "../format";
import { Markdown } from "../markdown";
import { AlertIcon, CheckIcon, ToolIcon, XCircleIcon } from "../icons";

const LONG_FIELDS = new Set(["body", "description", "steps", "text"]);

/** Confirm / Edit / Cancel card for an outward-facing action (S1). */
export function ActionCard({ action, onChange }: { action: Action; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [args, setArgs] = useState<Record<string, unknown>>(action.args);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const startEditing = () => {
    setArgs(action.args);
    const initial: Record<string, string> = {};
    for (const [k, v] of Object.entries(action.args)) {
      if (typeof v === "string" || typeof v === "number") initial[k] = String(v);
    }
    setDrafts(initial);
    setError("");
    setEditing(true);
  };

  const buildEditedArgs = (): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...args };
    for (const [k, orig] of Object.entries(action.args)) {
      if (!(k in drafts)) continue;
      const raw = drafts[k]!;
      if (typeof orig === "number") {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || raw.trim() === "") throw new Error(`${k.replace(/_/g, " ")} must be a valid number.`);
        out[k] = parsed;
      } else {
        out[k] = raw;
      }
    }
    return out;
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pending = action.status === "pending";
  const browser = isBrowserTool(action.tool);
  // A browser step's ref and switches are for the model, and its description is already the summary.
  const entries = Object.entries(editing ? args : action.args).filter(
    ([k, v]) => k !== "reply_to_id" && !(browser && (BROWSER_HIDDEN_ARGS.has(k) || (k === "description" && v === action.summary))),
  );

  return (
    <div className={`action-card ${action.status}`} data-testid="action-card" data-status={action.status}>
      <div className="action-head">
        <span className="action-kind">
          <ToolIcon tool={action.tool} />
          {toolLabel(action.tool)}
        </span>
        <ActionStatus status={action.status} />
      </div>
      <div className="action-summary">{prettyDates(action.summary)}</div>
      {entries.length ? (
        <dl className="action-args">
          {entries.map(([k, v]) => (
            <div key={k} className={LONG_FIELDS.has(k) ? "long" : ""}>
              <dt>{k.replace(/_/g, " ")}</dt>
              <dd>
                {editing && (typeof v === "string" || typeof v === "number") ? (
                  LONG_FIELDS.has(k) ? (
                    <textarea value={drafts[k] ?? String(v)} rows={6} onChange={(e) => setDrafts({ ...drafts, [k]: e.target.value })} data-testid={`edit-${k}`} />
                  ) : (
                    <input value={drafts[k] ?? String(v)} onChange={(e) => setDrafts({ ...drafts, [k]: e.target.value })} data-testid={`edit-${k}`} />
                  )
                ) : Array.isArray(v) ? (
                  v.join(", ")
                ) : typeof v === "object" && v !== null ? (
                  JSON.stringify(v)
                ) : (
                  prettyDates(String(v))
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {!pending ? <ActionResult action={action} /> : null}
      {error ? <div className="error">{error}</div> : null}
      {pending ? (
        <div className="action-buttons">
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              void run(() => api.post(`/api/actions/${action.id}/confirm`, editing ? { args: buildEditedArgs() } : {}))
            }
            data-testid="action-confirm"
          >
            {editing ? "Save & confirm" : "Confirm"}
          </button>
          {!editing ? (
            <button className="btn" disabled={busy} onClick={startEditing} data-testid="action-edit">
              Edit
            </button>
          ) : (
            <button
              className="btn"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError("");
              }}
              data-testid="action-edit-back"
            >
              Back
            </button>
          )}
          <button className="btn ghost" disabled={busy} onClick={() => void run(() => api.post(`/api/actions/${action.id}/cancel`))} data-testid="action-cancel">
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** What came back: raw output like a terminal, then a plain note; the page a browser step ended on; else the result as text. */
function ActionResult({ action }: { action: Action }) {
  const d = action.display;
  if (d && (d.output || d.note)) {
    return (
      <div className="action-result" data-testid="action-result">
        {d.output ? <pre className="action-output">{d.output}</pre> : null}
        {d.note ? <Markdown className="action-note" text={d.note} /> : null}
      </div>
    );
  }
  const page = isBrowserTool(action.tool) ? browserPage(action.result) : null;
  if (page) {
    return (
      <div className="action-result action-page" data-testid="action-result">
        <a href={page.url} target="_blank" rel="noreferrer">
          <span className="action-page-title">{page.title || page.host}</span>
          {page.title ? <span className="action-page-host">{page.host}</span> : null}
        </a>
      </div>
    );
  }
  const text = unframe(action.result ?? "");
  return text ? (
    <div className="action-result" data-testid="action-result">
      {prettyDates(text)}
    </div>
  ) : null;
}

/** Pending needs no label: the Confirm button already says it. */
function ActionStatus({ status }: { status: Action["status"] }) {
  if (status === "pending") return null;
  if (status === "done")
    return (
      <span className="status-pill done">
        <CheckIcon />
        Done
      </span>
    );
  if (status === "cancelled")
    return (
      <span className="status-pill">
        <XCircleIcon />
        Cancelled
      </span>
    );
  if (status === "failed")
    return (
      <span className="status-pill failed">
        <AlertIcon />
        Failed
      </span>
    );
  // Running: the thread's live line already shows Vireo working; the card only names the step.
  return <span className="status-pill">Running</span>;
}
