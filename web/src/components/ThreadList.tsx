import type { Thread } from "../api";
import { relTime } from "../format";
import { HomeIcon } from "../icons";

const GROUPS: { key: Thread["group"]; label: string }[] = [
  { key: "needs_you", label: "Needs you" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
];

export function ThreadList({ threads, current }: { threads: Thread[]; current: string | null }) {
  const overview = threads.find((t) => t.group === "overview");
  return (
    <div className="thread-list" data-testid="thread-list">
      {overview ? <Row t={overview} active={current === overview.id} /> : null}
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

function Row({ t, active }: { t: Thread; active: boolean }) {
  const status = t.statusLine || (t.group === "done" ? t.summary : "");
  const hint = [t.temporary ? "Temporary" : "", status].filter(Boolean).join(" · ");
  return (
    <a
      href={`#thread/${t.id}`}
      className={`thread-row ${active ? "active" : ""} ${t.group}`}
      data-testid="thread-row"
      data-thread-id={t.id}
      title={hint || undefined}
    >
      {t.group === "overview" ? <HomeIcon /> : null}
      <span className="title">{t.title}</span>
      {t.running ? <span className="pulse" aria-label="Working" /> : t.needsYou ? <span className="dot attention" aria-label="Needs you" /> : null}
      <span className="time">{relTime(t.updatedAt)}</span>
    </a>
  );
}
