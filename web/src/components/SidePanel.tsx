import { useEffect, useState } from "react";
import { api, type ThreadDetail } from "../api";
import { bytes, dateTime, toolLabel } from "../format";
import { CloseIcon } from "../icons";

interface ToolCallRow {
  id: number;
  tool: string;
  agent: string | null;
  args: string;
  result: string | null;
  status: string;
  started_at: number;
  duration_ms: number | null;
}

interface LlmRow {
  id: number;
  purpose: string;
  agent: string | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
}

/** Everything related to the thread: pages, emails, events, files, and the full audit trail (S6, N7). */
export function SidePanel({ detail, onClose }: { detail: ThreadDetail; onClose: () => void }) {
  const [tab, setTab] = useState<"related" | "activity">("related");
  const [audit, setAudit] = useState<{ toolCalls: ToolCallRow[]; llmCalls: LlmRow[] } | null>(null);
  const tid = detail.thread.id;

  useEffect(() => {
    if (tab === "activity") void api.get<{ toolCalls: ToolCallRow[]; llmCalls: LlmRow[] }>(`/api/threads/${tid}/audit`).then(setAudit);
  }, [tab, tid, detail]);

  const totalCost = audit?.llmCalls.reduce((n, c) => n + (c.cost || 0), 0) ?? 0;
  const totalTokens = audit?.llmCalls.reduce((n, c) => n + c.input_tokens + c.output_tokens, 0) ?? 0;

  return (
    <aside className="side-panel" data-testid="side-panel">
      <div className="panel-tabs">
        <button className={tab === "related" ? "on" : ""} onClick={() => setTab("related")}>
          Related
        </button>
        <button className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")} data-testid="tab-activity">
          Activity
        </button>
        <button className="close" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </div>
      {tab === "related" ? (
        <div className="panel-body">
          {detail.related.length === 0 && detail.files.length === 0 ? <p className="muted">Pages, emails, events and files used in this thread show up here.</p> : null}
          {detail.files.length ? (
            <section>
              <h4>Files</h4>
              {detail.files.map((f) => (
                <a key={f.id} className="related-item" href={`/api/files/${f.id}`} target="_blank" rel="noreferrer">
                  {f.mime.startsWith("image/") ? <img src={`/api/files/${f.id}`} alt="" className="thumb" /> : <span className="kind">{f.origin === "produced" ? "📄" : "📎"}</span>}
                  <span>
                    {f.name}
                    <small className="muted"> · {bytes(f.size)}</small>
                  </span>
                </a>
              ))}
            </section>
          ) : null}
          {(["event", "email", "page"] as const).map((kind) => {
            const list = detail.related.filter((r) => r.kind === kind);
            if (!list.length) return null;
            return (
              <section key={kind}>
                <h4>{kind === "event" ? "Events" : kind === "email" ? "Emails" : "Web pages"}</h4>
                {list.map((r) => (
                  <a key={r.id} className="related-item" href={r.url ?? undefined} target="_blank" rel="noreferrer">
                    <span className="kind">{kind === "event" ? "📅" : kind === "email" ? "✉︎" : "🌐"}</span>
                    <span>
                      {r.title}
                      {r.data && "start" in r.data ? <small className="muted"> · {dateTime(Date.parse(String(r.data.start)))}</small> : null}
                      {r.url && kind === "page" ? <small className="muted url">{r.url}</small> : null}
                    </span>
                  </a>
                ))}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="panel-body" data-testid="audit">
          {!audit ? (
            <p className="muted">Loading…</p>
          ) : (
            <>
              <p className="muted">
                {audit.toolCalls.length} actions · {audit.llmCalls.length} model calls · {totalTokens.toLocaleString()} tokens · ${totalCost.toFixed(4)}
              </p>
              <h4>Actions</h4>
              {audit.toolCalls.map((c) => (
                <details key={c.id} className={`audit-row ${c.status}`} data-testid="audit-row">
                  <summary>
                    <span>{c.tool.startsWith("transfer_to_") ? `Handed to ${c.tool.slice(12)}` : toolLabel(c.tool)}</span>
                    <small className="muted">
                      {c.status.replace(/_/g, " ")} · {c.agent} · {c.duration_ms ?? "…"} ms · {dateTime(c.started_at)}
                    </small>
                  </summary>
                  <pre>{c.args}</pre>
                  {c.result ? <pre>{c.result}</pre> : null}
                </details>
              ))}
              <h4>Model calls</h4>
              {audit.llmCalls.map((c) => (
                <div key={c.id} className="audit-llm">
                  <span>
                    {c.purpose}
                    {c.agent ? ` · ${c.agent}` : ""}
                  </span>
                  <small className="muted">
                    {c.provider}/{c.model} · {c.input_tokens}→{c.output_tokens} tok · ${c.cost.toFixed(4)} · {c.duration_ms ?? "?"} ms
                    {c.error ? ` · ${c.error}` : ""}
                  </small>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
