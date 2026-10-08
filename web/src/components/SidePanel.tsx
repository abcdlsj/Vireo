import { useEffect, useRef, useState } from "react";
import { api, fileUrl, type ThreadDetail } from "../api";
import { authedUrl } from "../hosts";
import { bytes, compact, dateTime, duration, purposeLabel, shortTime, stepOutcome, stepSubject, tokens, toolLabel, usd } from "../format";
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
  cached_tokens: number;
  cost: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
}

/** Everything related to the thread: pages, emails, events, files, and the full audit trail (S6, N7). */
export function SidePanel({ detail, running, browsing, onClose }: { detail: ThreadDetail; running: boolean; browsing: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"related" | "browser" | "activity" | "usage">(browsing ? "browser" : "related");
  useEffect(() => {
    if (browsing) setTab("browser");
  }, [browsing]);
  const [audit, setAudit] = useState<{ toolCalls: ToolCallRow[]; llmCalls: LlmRow[] } | null>(null);
  const tid = detail.thread.id;

  useEffect(() => {
    if (tab === "activity") void api.get<{ toolCalls: ToolCallRow[]; llmCalls: LlmRow[] }>(`/api/threads/${tid}/audit`).then(setAudit);
  }, [tab, tid, detail]);

  const totalCost = audit?.llmCalls.reduce((n, c) => n + (c.cost ?? 0), 0) ?? 0;
  const totalTokens = audit?.llmCalls.reduce((n, c) => n + c.input_tokens + c.output_tokens, 0) ?? 0;

  return (
    <aside className="side-panel" data-testid="side-panel">
      <div className="panel-tabs">
        <button className={tab === "related" ? "on" : ""} onClick={() => setTab("related")}>
          Related
        </button>
        <button className={tab === "browser" ? "on" : ""} onClick={() => setTab("browser")} data-testid="tab-browser">
          Browser
        </button>
        <button className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")} data-testid="tab-activity">
          Activity
        </button>
        <button className={tab === "usage" ? "on" : ""} onClick={() => setTab("usage")} data-testid="tab-usage">
          Usage
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
                <a key={f.id} className="related-item" href={fileUrl(f.id)} target="_blank" rel="noreferrer">
                  {f.mime.startsWith("image/") ? <img src={fileUrl(f.id)} alt="" className="thumb" /> : <span className="kind">{f.origin === "produced" ? "📄" : "📎"}</span>}
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
      ) : tab === "browser" ? (
        <BrowserView threadId={tid} running={running} />
      ) : tab === "usage" ? (
        <UsageView threadId={tid} detail={detail} />
      ) : (
        <div className="panel-body" data-testid="audit">
          {!audit ? (
            <p className="muted">Loading…</p>
          ) : (
            <>
              <div className="audit-stats">
                <div>
                  <b>{audit.toolCalls.length}</b>
                  <span>actions</span>
                </div>
                <div>
                  <b>{audit.llmCalls.length}</b>
                  <span>model calls</span>
                </div>
                <div>
                  <b>{compact(totalTokens)}</b>
                  <span>tokens</span>
                </div>
                <div>
                  <b>{usd(totalCost)}</b>
                  <span>cost</span>
                </div>
              </div>
              <h4>
                Actions <span className="count">{audit.toolCalls.length}</span>
              </h4>
              <div className="audit-list">
                {[...audit.toolCalls].reverse().map((c) => {
                  const handoff = c.tool.startsWith("transfer_to_");
                  const subject = handoff ? "" : stepSubject(c.args);
                  const outcome = handoff ? "" : stepOutcome(c.result);
                  return (
                    <details key={c.id} className={`audit-row ${c.status}`} data-testid="audit-row">
                      <summary>
                        <span className="step-mark">{c.status === "running" ? "◌" : c.status === "error" ? "✕" : c.status === "awaiting_confirmation" ? "•" : handoff ? "→" : "✓"}</span>
                        <span className="audit-main">
                          <span className="audit-title">{handoff ? `Handed to ${c.tool.slice(12)}` : toolLabel(c.tool)}</span>
                          {subject ? <span className="audit-subject">{subject}</span> : null}
                          {outcome ? <span className="audit-outcome">{outcome}</span> : null}
                          <span className="audit-meta">
                            {c.status === "ok" ? "" : `${c.status.replace(/_/g, " ")} · `}
                            {c.agent} · {duration(c.duration_ms)} · {shortTime(c.started_at)}
                          </span>
                        </span>
                      </summary>
                      <pre>{c.args}</pre>
                      {c.result ? <pre>{c.result}</pre> : null}
                    </details>
                  );
                })}
              </div>
              <h4>
                Model calls <span className="count">{audit.llmCalls.length}</span>
              </h4>
              <div className="audit-list">
                {[...audit.llmCalls].reverse().map((c) => (
                  <div key={c.id} className={`audit-llm ${c.error ? "error" : ""}`}>
                    <span className="audit-title">{purposeLabel(c.purpose, c.agent)}</span>
                    <span className="num">
                      {compact(c.input_tokens)} → {compact(c.output_tokens)}
                    </span>
                    <span className="audit-meta">
                      {c.model} · {duration(c.duration_ms)} · {c.cost === null ? "no price" : usd(c.cost)}
                      {c.cached_tokens ? ` · ${compact(c.cached_tokens)} cached` : ""} · {shortTime(c.created_at)}
                      {c.error ? ` · ${c.error}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

interface ModelUsage {
  model: string;
  calls: number;
  /** Prompt tokens, cached ones included. */
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  cost: number | null;
}

interface Usage {
  scope: "thread" | "all";
  models: ModelUsage[];
  context: { model: string; used: number; limit: number | null } | null;
}

/** Context window fill for this thread, then tokens and cost per model; the overview totals every thread. */
function UsageView({ threadId, detail }: { threadId: string; detail: ThreadDetail }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    void api.get<Usage>(`/api/threads/${threadId}/usage`).then(setUsage);
  }, [threadId, detail]);
  if (!usage) return <div className="panel-body muted">Loading…</div>;

  const sum = (f: (m: ModelUsage) => number) => usage.models.reduce((n, m) => n + f(m), 0);
  const input = sum((m) => m.input);
  const cached = sum((m) => m.cached);
  const cacheWrite = sum((m) => m.cacheWrite);
  const output = sum((m) => m.output);
  const total = input + output;
  const priced = usage.models.filter((m) => m.cost !== null);
  const cost = priced.length ? priced.reduce((n, m) => n + (m.cost ?? 0), 0) : null;
  const parts = [
    { key: "fresh", label: "Input", value: Math.max(0, input - cached - cacheWrite) },
    { key: "write", label: "Cache write", value: cacheWrite },
    { key: "read", label: "Cache read", value: cached },
    { key: "output", label: "Output", value: output },
  ];
  const ctx = usage.context;
  const ctxShare = ctx?.limit ? Math.min(1, ctx.used / ctx.limit) : null;

  return (
    <div className="panel-body usage" data-testid="usage">
      {ctx ? (
        <section className="usage-context" data-testid="usage-context">
          <h4>Context window</h4>
          <div className="meter" role="meter" aria-label="Context window used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ctxShare === null ? undefined : Math.round(ctxShare * 100)}>
            <span className={ctxShare !== null && ctxShare > 0.8 ? "high" : ""} style={{ width: `${(ctxShare ?? 0) * 100}%` }} />
          </div>
          <div className="usage-line">
            <span>
              {tokens(ctx.used)} / {ctx.limit ? tokens(ctx.limit) : "unknown"}
            </span>
            <span className="muted">{ctxShare === null ? "" : `${Math.round(ctxShare * 100)}%`}</span>
          </div>
          <small className="muted">{ctx.model}</small>
        </section>
      ) : null}

      <section>
        <h4>{usage.scope === "all" ? "Usage across all threads" : "Usage in this thread"}</h4>
        <div className="usage-stats">
          <div>
            <small className="muted">Tokens</small>
            <strong data-testid="usage-tokens">{tokens(total)}</strong>
          </div>
          <div>
            <small className="muted">Cost</small>
            <strong data-testid="usage-cost">{usd(cost)}</strong>
          </div>
          <div>
            <small className="muted">Cache hit</small>
            <strong>{input ? `${Math.round((cached / input) * 100)}%` : "—"}</strong>
          </div>
        </div>
        {total ? (
          <>
            <div className="usage-bar" aria-hidden="true">
              {parts.map((p) => (p.value ? <span key={p.key} className={p.key} style={{ flexGrow: p.value }} /> : null))}
            </div>
            <ul className="usage-legend">
              {parts.map((p) => (
                <li key={p.key}>
                  <span className={`swatch ${p.key}`} />
                  {p.label}
                  <span className="muted">{tokens(p.value)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">No model calls yet.</p>
        )}
      </section>

      {usage.models.length ? (
        <section>
          <h4>By model</h4>
          {usage.models.map((m) => (
            <div key={m.model} className="usage-model" data-testid="usage-model">
              <div className="usage-line">
                <span className="name" title={m.model}>
                  {m.model}
                </span>
                <span>{m.cost === null ? <span className="muted">no price</span> : usd(m.cost)}</span>
              </div>
              <small className="muted">
                {tokens(m.input + m.output)} · in {tokens(m.input)} ({m.input ? Math.round((m.cached / m.input) * 100) : 0}% cached) · out {tokens(m.output)} · {m.calls} calls
              </small>
            </div>
          ))}
          <p className="muted fine">Prices from models.dev.</p>
        </section>
      ) : null}
    </div>
  );
}

/** The thread's browser tab; refreshes frame by frame while the agent is working. */
function BrowserView({ threadId, running }: { threadId: string; running: boolean }) {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<"loading" | "shown" | "none">("loading");
  const timer = useRef<number | undefined>(undefined);

  // Fetch a fresh frame when the run starts or stops; while running, the next frame is requested after each load.
  useEffect(() => setTick((n) => n + 1), [running]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const next = () => {
    window.clearTimeout(timer.current);
    if (running) timer.current = window.setTimeout(() => setTick((n) => n + 1), 250);
  };

  return (
    <div className="panel-body browser-view" data-testid="browser-view">
      <div className="browser-head">
        {running && state === "shown" ? <span className="live-dot" aria-hidden="true" /> : null}
        <span>{state === "none" ? "" : running ? "Live" : "Last seen"}</span>
      </div>
      {state === "none" ? <p className="muted">When Vireo browses the web for this thread, the page shows up here.</p> : null}
      <img
        key={threadId}
        src={authedUrl(`/api/threads/${threadId}/browser?t=${tick}`)}
        alt="The page Vireo is looking at"
        hidden={state !== "shown"}
        onLoad={() => {
          setState("shown");
          next();
        }}
        onError={() => {
          setState((s) => (s === "shown" ? s : "none"));
          next();
        }}
      />
    </div>
  );
}
