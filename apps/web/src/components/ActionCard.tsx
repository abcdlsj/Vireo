import { useState } from "react";
import { api, type Action } from "../api";
import { prettyDates, toolLabel } from "../format";
import { AlertIcon, CheckIcon, ToolIcon, XCircleIcon } from "../icons";

const LONG_FIELDS = new Set(["body", "description", "steps", "text"]);

/** Confirm / Edit / Cancel card for an outward-facing action (S1). */
export function ActionCard({ action, onChange }: { action: Action; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [args, setArgs] = useState<Record<string, unknown>>(action.args);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
  const entries = Object.entries(editing ? args : action.args).filter(([k]) => k !== "reply_to_id");

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
      <dl className="action-args">
        {entries.map(([k, v]) => (
          <div key={k} className={LONG_FIELDS.has(k) ? "long" : ""}>
            <dt>{k.replace(/_/g, " ")}</dt>
            <dd>
              {editing && (typeof v === "string" || typeof v === "number") ? (
                LONG_FIELDS.has(k) ? (
                  <textarea value={String(v)} rows={6} onChange={(e) => setArgs({ ...args, [k]: e.target.value })} data-testid={`edit-${k}`} />
                ) : (
                  <input value={String(v)} onChange={(e) => setArgs({ ...args, [k]: typeof v === "number" ? Number(e.target.value) : e.target.value })} data-testid={`edit-${k}`} />
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
      {action.result && !pending ? <div className="action-result">{prettyDates(action.result)}</div> : null}
      {error ? <div className="error">{error}</div> : null}
      {pending ? (
        <div className="action-buttons">
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void run(() => api.post(`/api/actions/${action.id}/confirm`, editing ? { args } : {}))}
            data-testid="action-confirm"
          >
            {editing ? "Save & confirm" : "Confirm"}
          </button>
          {!editing ? (
            <button className="btn" disabled={busy} onClick={() => setEditing(true)} data-testid="action-edit">
              Edit
            </button>
          ) : null}
          <button className="btn ghost" disabled={busy} onClick={() => void run(() => api.post(`/api/actions/${action.id}/cancel`))} data-testid="action-cancel">
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
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
  return (
    <span className="status-pill">
      <span className="pulse" />
      Working
    </span>
  );
}
