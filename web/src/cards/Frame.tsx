import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { api } from "../api";
import { relTime } from "../format";
import { ArrowUpRightIcon, CheckIcon } from "../icons";
import { go } from "../route";
import { pressButton } from "./registry";
import type { Card, CardButton } from "./types";

/**
 * What the board lets a card do beyond itself: open it in the peek sheet,
 * and reload after the owner closes its matter. Off the board (a thread's
 * page) there is no board, and a card opens its thread.
 */
export interface Board {
  peek: (card: Card) => void;
  refresh: () => void;
}

export const BoardContext = createContext<Board | null>(null);

/** Derived cards (a confirmation, a reminder) have no matter of their own to close. */
function closable(card: Card): boolean {
  return card.threadId !== "overview" && card.kind !== "proposal" && card.kind !== "reminder" && card.status !== "done";
}

/**
 * On the board, a list of rows that has no room for even its first row is
 * left out rather than shown as a cut-off sliver (the CSS hides later rows).
 */
function useFitRows(expanded: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = ref.current;
    if (expanded || !body) return;
    const fit = () => {
      for (const list of body.querySelectorAll<HTMLElement>(":scope > .c-rows")) {
        list.classList.remove("no-room");
        const first = list.firstElementChild as HTMLElement | null;
        if (first && list.clientHeight < first.offsetHeight) list.classList.add("no-room");
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(body);
    return () => ro.disconnect();
  });
  return ref;
}

/** True for a moment after the card's content changes, so the change is seen. */
function useJustUpdated(card: Card): boolean {
  const seen = useRef(card.updatedAt);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (card.updatedAt === seen.current) return;
    seen.current = card.updatedAt;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 1400);
    return () => window.clearTimeout(t);
  }, [card.updatedAt]);
  return flash;
}

export type Tone = "paper" | "warm" | "accent" | "dark" | "quiet" | "bare";

/**
 * The shared frame every card kind draws inside: a label on the left, the
 * status on the right, the kind's own body, and its buttons. Kinds choose a
 * tone (their material) and fill the body; the frame keeps size, spacing and
 * behaviour the same everywhere.
 */
export function Frame({
  card,
  expanded,
  tone = "paper",
  label,
  children,
  buttons,
  flush,
  className,
}: {
  card: Card;
  expanded: boolean;
  tone?: Tone;
  label?: ReactNode;
  children: ReactNode;
  /** Replaces the card's own buttons, e.g. Confirm on a proposal. */
  buttons?: ReactNode;
  /** The body reaches the card's edges (images, ticket stubs). */
  flush?: boolean;
  className?: string;
}) {
  const board = useContext(BoardContext);
  const flash = useJustUpdated(card);
  const body = useFitRows(expanded);
  const [leaving, setLeaving] = useState(false);
  const interactive = !expanded;
  const open = () => (board ? board.peek(card) : go(`thread/${card.threadId}`));
  const onClick = (e: MouseEvent) => {
    if (!interactive) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    open();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!interactive || e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };
  const markDone = async () => {
    setLeaving(true);
    try {
      await api.post(`/api/threads/${card.threadId}/done`);
    } finally {
      // Let the card fold away before the board closes the gap.
      window.setTimeout(() => board?.refresh(), 220);
    }
  };
  const own = buttons ?? (card.buttons.length ? <Buttons card={card} buttons={card.buttons} /> : null);
  const actions = interactive ? (
    <span className="vcard-actions">
      {board && closable(card) ? (
        <button className="vcard-act" onClick={() => void markDone()} title="Mark done" aria-label="Mark done" data-testid="card-done">
          <CheckIcon />
        </button>
      ) : null}
      <a className="vcard-act" href={`#thread/${card.threadId}`} title="Open thread" aria-label="Open thread" data-testid="card-open">
        <ArrowUpRightIcon />
      </a>
    </span>
  ) : null;
  return (
    <article
      className={`vcard tone-${tone} ${expanded ? "expanded" : ""} ${flush ? "flush" : ""} ${card.status} ${flash ? "just-updated" : ""} ${leaving ? "leaving" : ""} ${className ?? ""}`}
      onClick={onClick}
      onKeyDown={onKey}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? card.title : undefined}
      data-testid="card"
      data-kind={card.kind}
      data-status={card.status}
      data-thread-id={card.threadId}
    >
      {label !== null ? (
        <header className="vcard-head">
          <span className="vcard-label">
            {label ?? (card.threadTitle && card.threadTitle !== card.title ? <a href={`#thread/${card.threadId}`}>{card.threadTitle}</a> : null)}
          </span>
          <span className="vcard-corner">
            <Status card={card} />
            {actions}
          </span>
        </header>
      ) : (
        <span className="vcard-corner floating">{actions}</span>
      )}
      <div className="vcard-body" ref={body}>
        {children}
      </div>
      {own ? <footer className="vcard-foot">{own}</footer> : null}
    </article>
  );
}

export function Status({ card }: { card: Card }) {
  if (card.status === "needs_you") return <span className="vcard-status needs">Needs you</span>;
  if (card.running || card.status === "working") return <span className="vcard-status working">Working</span>;
  if (card.status === "watching") return <span className="vcard-status watching">Watching</span>;
  if (card.status === "done") return <span className="vcard-status done">Done</span>;
  return <span className="vcard-status quiet">{relTime(card.updatedAt)}</span>;
}

export function Buttons({ card, buttons }: { card: Card; buttons: CardButton[] }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [sent, setSent] = useState("");
  if (sent) {
    return (
      <span className="vcard-sent" data-testid="card-sent">
        <span className="you">You</span>
        {sent}
        <span className="on-it">Vireo is on it</span>
      </span>
    );
  }
  return (
    <div className="vcard-buttons">
      {buttons.map((b, i) => (
        <button
          key={i}
          className={`cbtn ${b.primary || (i === 0 && buttons.length > 0 && !buttons.some((x) => x.primary)) ? "primary" : ""}`}
          disabled={busy !== null}
          aria-busy={busy === i}
          onClick={() => {
            setBusy(i);
            void pressButton(card, b)
              .then(() => b.reply && setSent(b.label))
              .finally(() => setBusy(null));
          }}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

/** A tiny line chart of recent values, oldest first. */
export function Sparkline({ values, width = 160, height = 28 }: { values: number[]; width?: number; height?: number }) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length < 2) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const pts = nums.map((v, i) => [(i / (nums.length - 1)) * (width - 6) + 3, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const last = pts[pts.length - 1]!;
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Recent values from ${nums[0]} to ${nums[nums.length - 1]}`}>
      <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="3" fill="currentColor" />
    </svg>
  );
}

const AVATAR_TONES = ["blue", "plum", "amber", "sage"];

export function Avatar({ name, size = 30 }: { name: string; size?: number }) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  const tone = AVATAR_TONES[[...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % AVATAR_TONES.length];
  return (
    <span className={`avatar ${tone}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {initial}
    </span>
  );
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
