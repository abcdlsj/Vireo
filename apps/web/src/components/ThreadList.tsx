import type { Thread } from "../api";
import { relTime } from "../format";
import { prefetchThread } from "../thread-cache";
import { attentionOf, Eyes, nowLine } from "./Eyes";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "../icons";

const GROUPS: { key: Thread["group"]; label: string }[] = [
  { key: "needs_you", label: "Needs you" },
  { key: "in_progress", label: "In hand" },
  { key: "done", label: "Done" },
  { key: "archived", label: "Archived" },
];

/** Groups that start folded, and the owner opens them; the choice is kept on this device. */
const FOLDED = new Set<Thread["group"]>(["archived"]);
const KEY = "vireo.group.open";

function startOpen(key: Thread["group"]): boolean {
  try {
    const kept = localStorage.getItem(`${KEY}.${key}`);
    if (kept !== null) return kept === "1";
  } catch {
    // Storage blocked: the default stands.
  }
  return !FOLDED.has(key);
}

function keepOpen(key: Thread["group"], open: boolean): void {
  try {
    localStorage.setItem(`${KEY}.${key}`, open ? "1" : "0");
  } catch {
    // Storage blocked: it just does not persist.
  }
}

export function ThreadList({ threads, current }: { threads: Thread[]; current: string | null }) {
  const [open, setOpen] = useState<Partial<Record<Thread["group"], boolean>>>(() => ({
    archived: startOpen("archived"),
  }));
  return (
    <div className="thread-list" data-testid="thread-list">
      {GROUPS.map((g) => {
        const items = threads.filter((t) => t.group === g.key);
        if (items.length === 0) return null;
        // A folded group says how many it holds, so nothing disappears without a trace.
        const folded = FOLDED.has(g.key);
        const shown = open[g.key] ?? startOpen(g.key);
        const toggle = () => {
          const next = !shown;
          setOpen((o) => ({ ...o, [g.key]: next }));
          keepOpen(g.key, next);
        };
        return (
          <section key={g.key} data-testid={`group-${g.key}`} data-open={folded ? String(shown) : undefined}>
            {folded ? (
              <h3>
                <button className="group-toggle" onClick={toggle} aria-expanded={shown} data-testid={`toggle-${g.key}`}>
                  {shown ? <ChevronDown /> : <ChevronRight />}
                  {g.label}
                  <span className="count">{items.length}</span>
                </button>
              </h3>
            ) : (
              <h3>
                {g.label}
                <span className="count">{items.length}</span>
              </h3>
            )}
            {(shown ? (g.key === "done" || g.key === "archived" ? items.slice(0, 30) : items) : []).map((t) => (
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
  // The eyes say working or needs you; the second line only adds what, and the open thread says it on its own page.
  const attn = attentionOf(t);
  const status = t.pendingActions ? `Waiting for your confirmation${t.pendingActions > 1 ? ` (${t.pendingActions})` : ""}` : t.running ? (active ? "" : nowLine(t.statusLine)) : t.statusLine || (t.group === "done" ? (t.summary ?? "") : "");
  const sub = [t.temporary ? "Temporary" : "", status].filter(Boolean).join(" · ");
  return (
    <a href={`#thread/${t.id}`} className={`thread-row ${active ? "active" : ""} ${t.group} ${attn === "working" ? "working" : ""} ${sub ? "two-line" : ""}`} data-testid="thread-row" data-thread-id={t.id} onPointerEnter={() => prefetchThread(t.id)} onTouchStart={() => prefetchThread(t.id)} title={sub || undefined}>
      <span className="row-text">
        <span className="row-top">
          <span className="title">{t.title}</span>
          {/* Under "Needs you" the heading already says so; elsewhere the eyes mark a matter being worked on. */}
          {!active && attn === "working" ? <Eyes state="working" /> : null}
          <span className="time">{relTime(t.updatedAt)}</span>
        </span>
        {sub ? <span className={`row-sub ${t.needsYou || t.pendingActions ? "attention" : ""}`}>{sub}</span> : null}
      </span>
    </a>
  );
}
