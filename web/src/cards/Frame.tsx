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

/** On the board, marks long text that its box cuts off, so only that text fades out. */
function useFade(expanded: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = ref.current;
    if (expanded || !body) return;
    const mark = () => {
      for (const el of body.querySelectorAll<HTMLElement>(".fade")) el.classList.toggle("cut", el.scrollHeight > el.clientHeight + 1);
    };
    mark();
    const ro = new ResizeObserver(mark);
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
  const body = useFade(expanded);
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
  const labelNode = label ?? (card.threadTitle && card.threadTitle !== card.title ? <a href={`#thread/${card.threadId}`}>{card.threadTitle}</a> : null);
  // A ready card with nothing to label needs no head: an empty line with only a time in it is noise.
  const quiet = card.status === "ready" && !card.running;
  const head = label !== null && !(labelNode === null && quiet);
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
      {head ? (
        <header className="vcard-head">
          <span className="vcard-label">{labelNode}</span>
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

/**
 * A small line chart of recent values, oldest first, with a soft wash under
 * the line. Without a width it fills its container and follows its size.
 */
export function Sparkline({ values, width, height = 28 }: { values: number[]; width?: number; height?: number }) {
  const box = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    if (width !== undefined || !box.current) return;
    const el = box.current;
    const ro = new ResizeObserver(() => setMeasured(Math.round(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  const w = width ?? measured;
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length < 2) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const pts = nums.map((v, i) => [(i / (nums.length - 1)) * (w - 8) + 4, height - 4 - ((v - min) / span) * (height - 8)] as const);
  const last = pts[pts.length - 1]!;
  const line = pts.map((p) => p.join(",")).join(" ");
  const svg = w > 0 && (
    <svg className="sparkline" width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label={`Recent values from ${nums[0]} to ${nums[nums.length - 1]}`}>
      <polygon points={`${pts[0]![0]},${height} ${line} ${last[0]},${height}`} fill="currentColor" opacity="0.08" />
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="3.5" fill="currentColor" stroke="var(--c-paper)" strokeWidth="2" />
    </svg>
  );
  if (width !== undefined) return svg || null;
  return (
    <span ref={box} className="sparkline-fill" style={{ height }}>
      {svg}
    </span>
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
