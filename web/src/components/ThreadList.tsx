import type { Thread } from "../api";
import { relTime } from "../format";

const GROUPS: { key: Thread["group"]; label: string }[] = [
  { key: "needs_you", label: "Needs you" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
];

export function ThreadList({ threads, current }: { threads: Thread[]; current: string | null }) {
  const overview = threads.find((t) => t.group === "overview");
  return (
    <div className="thread-list" data-testid="thread-list">
      {overview ? <Row t={overview} active={current === overview.id || current === null} /> : null}
      {GROUPS.map((g) => {
        const items = threads.filter((t) => t.group === g.key);
        if (items.length === 0) return null;
        return (
          <section key={g.key} data-testid={`group-${g.key}`}>
            <h3>
              {g.label} <span className="count">{items.length}</span>
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

function Row({ t, active }: { t: Thread; active: boolean }) {
  return (
    <a href={`#thread/${t.id}`} className={`thread-row ${active ? "active" : ""} ${t.group}`} data-testid="thread-row" data-thread-id={t.id}>
      <div className="row-top">
        <span className="title">
          {t.pinned ? "◆ " : ""}
          {t.title}
        </span>
        <span className="time">{relTime(t.updatedAt)}</span>
      </div>
      <div className="row-status">
        {t.running ? <span className="pulse" /> : t.needsYou ? <span className="dot attention" /> : null}
        {t.temporary ? <span className="tag">temporary</span> : null}
        <span className="status">{t.statusLine || (t.group === "done" ? t.summary : "") || " "}</span>
      </div>
    </a>
  );
}
