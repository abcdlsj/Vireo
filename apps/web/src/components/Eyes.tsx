/**
 * Vireo's one attention mark: a pair of small eyes. Each view shows a
 * matter's state once, with this mark, and nowhere else.
 *
 * - working: green, glancing side to side with the odd blink (busy, not for you)
 * - needs: amber, looking straight out with a small hop now and then (your turn)
 * - done: smiling arcs, grey
 * - idle: closed, grey
 */
export type Attention = "idle" | "working" | "needs" | "done";

const LABEL: Record<Attention, string> = { idle: "Idle", working: "Working", needs: "Needs you", done: "Done" };

/** A matter waiting on a confirmation needs the owner even while the agent is still talking. */
export function attentionOf(t: { running?: boolean; needsYou?: boolean; pendingActions?: number; status?: string; state?: string }): Attention {
  if (t.needsYou || (t.pendingActions ?? 0) > 0 || t.status === "needs_you") return "needs";
  if (t.running || t.status === "working") return "working";
  if (t.state === "done" || t.status === "done") return "done";
  return "idle";
}

/** What Vireo is doing now, or "" when the line only says that it is working: the eyes already say that. */
export function nowLine(statusLine?: string | null): string {
  const s = (statusLine ?? "").trim();
  return /^(working( on it)?|waiting for your confirmation)(…|\.\.\.)?$/i.test(s) ? "" : s;
}

export function Eyes({ state, title }: { state: Attention; title?: string }) {
  const label = title ?? LABEL[state];
  return (
    <svg className={`eyes ${state}`} viewBox="0 0 16 10" width="16" height="10" role="img" aria-label={label} data-testid="eyes" data-state={state}>
      <title>{label}</title>
      <g className="eyes-look">
        {state === "done" ? (
          <>
            <path d="M3.2 6 Q5 3.6 6.8 6" />
            <path d="M9.2 6 Q11 3.6 12.8 6" />
          </>
        ) : state === "idle" ? (
          <>
            <path d="M3.4 5.5 H6.6" />
            <path d="M9.4 5.5 H12.6" />
          </>
        ) : (
          <>
            <circle className="eye" cx="5" cy="5" r={state === "needs" ? 2.1 : 1.8} />
            <circle className="eye" cx="11" cy="5" r={state === "needs" ? 2.1 : 1.8} />
          </>
        )}
      </g>
    </svg>
  );
}
