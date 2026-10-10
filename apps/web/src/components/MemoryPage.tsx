import { useCallback, useEffect, useState } from "react";
import { api, onEvent, type Episode, type Fact, type Procedure } from "../api";
import { dateTime, shortTime } from "../format";
import { ArrowUpRightIcon, ChevronLeft } from "../icons";
import { Markdown } from "../markdown";

/** What Vireo remembers — searchable, correctable and deletable by the owner (M6). */
export function MemoryPage() {
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState(false);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [adding, setAdding] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (history) params.set("history", "1");
    const r = await api.get<{ facts: Fact[]; episodes: Episode[] }>(`/api/memory?${params}`);
    setFacts(r.facts);
    setEpisodes(r.episodes);
    setProcedures((await api.get<{ procedures: Procedure[] }>("/api/procedures")).procedures);
  }, [query, history]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 150);
    return () => window.clearTimeout(t);
  }, [load]);
  useEffect(() => onEvent((e) => (e.type === "memory.updated" || e.type === "procedure.updated" ? void load() : undefined)), [load]);

  const groups = new Map<string, Fact[]>();
  for (const f of facts) {
    const k = f.entityName;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(f);
  }

  return (
    <div className="page" data-testid="memory-page">
      <header className="topbar">
        <a href="#" className="back" aria-label="Back">
          <ChevronLeft />
        </a>
        <span className="crumbs">
          <span className="crumb-root">Vireo</span>
          <span className="crumb-sep">/</span>
          <span className="crumb-here">Memory</span>
        </span>
      </header>
      <div className="page-body">
        <h1 className="page-title">Memory</h1>
        <p className="muted">
          What Vireo knows about you, shared across all threads. Newer facts replace older ones; every fact links to where it came from. Correct or delete anything.
        </p>
        <div className="toolbar">
          <input type="search" placeholder="Search memory…" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="memory-search" />
          <label className="check">
            <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> Show replaced and expired
          </label>
        </div>
        <form
          className="add-fact"
          onSubmit={(e) => {
            e.preventDefault();
            if (!adding.trim()) return;
            void api.post("/api/memory/facts", { statement: adding.trim() }).then(() => {
              setAdding("");
              void load();
            });
          }}
        >
          <input placeholder="Tell Vireo something to remember…" value={adding} onChange={(e) => setAdding(e.target.value)} />
          <button className="btn small">Add</button>
        </form>

        {facts.length === 0 ? <p className="empty">{query ? "Nothing matches." : "Nothing remembered yet. Mention preferences, people and decisions in any thread."}</p> : null}
        {[...groups.entries()].map(([entity, list]) => (
          <section key={entity} className="fact-group">
            <h3>{entity === "Owner" ? "You" : entity}</h3>
            {list.map((f) => (
              <FactRow key={f.id} f={f} onChange={load} />
            ))}
          </section>
        ))}

        {procedures.length ? (
          <section className="fact-group">
            <h3>Procedures</h3>
            {procedures.map((p) => (
              <details key={p.id} className="procedure-row">
                <summary>
                  <strong>{p.name}</strong> <span className={`status-pill ${p.status}`}>{p.status}</span>
                  <span className="muted"> — {p.description}</span>
                </summary>
                <Markdown text={p.steps} />
                <div className="action-buttons">
                  {p.status !== "approved" ? (
                    <button className="btn small" onClick={() => void api.post(`/api/procedures/${p.id}/approve`).then(load)}>
                      Approve
                    </button>
                  ) : (
                    <button className="btn small" onClick={() => void api.post(`/api/procedures/${p.id}/reject`).then(load)}>
                      Disable
                    </button>
                  )}
                  <button className="btn small ghost" onClick={() => void api.del(`/api/procedures/${p.id}`).then(load)}>
                    Delete
                  </button>
                </div>
              </details>
            ))}
          </section>
        ) : null}

        {episodes.length ? (
          <section className="fact-group">
            <h3>Recent episodes</h3>
            {episodes.slice(0, 15).map((e) => (
              <div key={e.id} className="episode">
                <span className="episode-time" title={dateTime(e.occurredAt)}>
                  {shortTime(e.occurredAt)}
                </span>
                <span className="episode-text">{e.content.replace(/^Owner said in "[^"]*": /, "").slice(0, 240)}</span>
                {e.threadId ? (
                  <a href={`#thread/${e.threadId}`} className="icon-btn" title="Open thread" aria-label="Open thread">
                    <ArrowUpRightIcon />
                  </a>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function FactRow({ f, onChange }: { f: Fact; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(f.statement);
  return (
    <div className={`fact ${f.current ? "" : "stale"}`} data-testid="fact" data-current={f.current ? "1" : "0"}>
      {editing ? (
        <form
          className="fact-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void api.patch(`/api/memory/facts/${f.id}`, { statement: value }).then(() => {
              setEditing(false);
              onChange();
            });
          }}
        >
          <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus data-testid="fact-input" />
          <button className="btn small primary">Save</button>
          <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <>
          <div className="fact-text" data-testid="fact-text">
            {f.statement}
          </div>
          <div className="fact-meta">
            <code>{f.key}</code>
            <span>since {dateTime(f.validFrom)}</span>
            {!f.current ? <span className="tag">{f.invalidatedAt ? `replaced ${dateTime(f.invalidatedAt)}` : "expired"}</span> : null}
            {f.sourceThreadId ? (
              <a href={`#thread/${f.sourceThreadId}`}>from “{f.sourceThreadTitle ?? "a thread"}”</a>
            ) : (
              <span>added by you</span>
            )}
            <span className="fact-actions">
              {f.current ? (
                <button className="link" onClick={() => setEditing(true)} data-testid="fact-edit">
                  Correct
                </button>
              ) : null}
              <button className="link danger" onClick={() => void api.del(`/api/memory/facts/${f.id}`).then(onChange)} data-testid="fact-delete">
                Delete
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
