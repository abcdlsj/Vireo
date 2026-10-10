import type { Thread } from "../api";
import { relTime } from "../format";

const GROUPS: { key: Thread["group"]; label: string }[] = [
  { key: "needs_you", label: "Needs you" },
  { key: "in_progress", label: "In hand" },
  { key: "done", label: "Done" },
];

export function ThreadList({ threads, current }: { threads: Thread[]; current: string | null }) {
  return (
    <div className="thread-list" data-testid="thread-list">
      {GROUPS.map((g) => {
        const items = threads.filter((t) => t.group === g.key);
        if (items.length === 0) return null;
        return (
          <section key={g.key} data-testid={`group-${g.key}`}>
            <h3>
              {g.label}
              <span className="count">{items.length}</span>
            </h3>
            {(g.key === "done" ? items.slice(0, 30) : items).map((t) => (
              <Row key={t.id} t={t} active={current === t.id} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** Title and time on the first line; what the thread is doing (or how it ended) on the second. */
function Row({ t, active }: { t: Thread; active: boolean }) {
  const status = t.running ? t.statusLine || "Working…" : t.pendingActions ? `Waiting for your confirmation${t.pendingActions > 1 ? ` (${t.pendingActions})` : ""}` : t.statusLine || (t.group === "done" ? (t.summary ?? "") : "");
  const sub = [t.temporary ? "Temporary" : "", status].filter(Boolean).join(" · ");
  return (
    <a href={`#thread/${t.id}`} className={`thread-row ${active ? "active" : ""} ${t.group} ${sub ? "two-line" : ""}`} data-testid="thread-row" data-thread-id={t.id} title={sub || undefined}>
      <span className="row-text">
        <span className="row-top">
          <span className="title">{t.title}</span>
          {t.running ? <span className="pulse" aria-label="Working" /> : t.needsYou ? <span className="dot attention" aria-label="Needs you" /> : null}
          <span className="time">{relTime(t.updatedAt)}</span>
        </span>
        {sub ? <span className={`row-sub ${t.needsYou || t.pendingActions ? "attention" : ""}`}>{sub}</span> : null}
      </span>
    </a>
  );
}
