import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { api } from "../api";
import { relTime } from "../format";
import { ArrowUpRightIcon, CheckIcon } from "../icons";
import { go } from "../route";
import { Eyes, nowLine } from "../components/Eyes";
import { pressButton } from "./registry";
import { field } from "./util";
import type { Card, CardButton } from "@vireo/protocol";

/**
 * What the board lets a card do beyond itself: open it in the peek sheet,
 * and reload after the owner closes its matter. Off the board (a thread's
 * page) there is no board, and a card opens its thread.
 */
export interface Board {
  peek: (card: Card) => void;
  refresh: () => void;
  /** The board puts cards under headings by status, so a card need not repeat it. */
  grouped?: boolean;
}

export const BoardContext = createContext<Board | null>(null);

/** Derived cards (a confirmation, a reminder, a browser ask) have no matter of their own to close. */
function closable(card: Card): boolean {
  return card.threadId !== "overview" && !["proposal", "reminder", "browser_request"].includes(card.kind) && card.status !== "done";
}

/**
 * On the board a card is a fixed number of grid rows high (cards.css): the
 * fewest of its allowed heights (CardSlot's data-heights) that hold its
 * content with prose cut to two lines, so a short answer is a short card
 * and none is left half empty. Content past the tallest is cut, in this
 * order: prose (`.fit`, up to `data-lines` lines) comes down to two lines,
 * lists (`.fit-list`) to two items, then prose to one line and lists to one
 * item. A list says how many it left out in the `.c-more` right after it.
 * Whatever still does not fit fades out at the bottom.
 */
function useFit(expanded: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = ref.current;
    if (expanded || !body) return;
    const slot = body.parentElement!.parentElement;
    const grid = slot?.parentElement;
    const fit = () => {
      const texts = [...body.querySelectorAll<HTMLElement>(".fit")];
      const lists = [...body.querySelectorAll<HTMLElement>(".fit-list")];
      const lines = (t: HTMLElement) => Number(t.style.getPropertyValue("--lines"));
      const shown = (l: HTMLElement) => [...l.children].filter((li) => !(li as HTMLElement).hidden) as HTMLElement[];
      const full = () => {
        for (const t of texts) t.style.setProperty("--lines", t.dataset.lines ?? "3");
      };
      full();
      for (const l of lists) for (const li of l.children) (li as HTMLElement).hidden = false;
      body.classList.remove("cut");
      const over = () => body.scrollHeight > body.clientHeight + 1;
      const text = (floor: number) => {
        while (over()) {
          const t = texts.filter((x) => lines(x) > floor).sort((a, b) => lines(b) - lines(a))[0];
          if (!t) return false;
          t.style.setProperty("--lines", String(lines(t) - 1));
        }
        return true;
      };
      const list = (floor: number) => {
        while (over()) {
          const l = lists.find((x) => shown(x).length > floor);
          if (!l) return false;
          shown(l).at(-1)!.hidden = true;
        }
        return true;
      };
      if (slot?.dataset.heights && grid) {
        const single = getComputedStyle(grid).gridTemplateColumns.split(" ").length === 1;
        // Where the board is one column, a large card can't be wider, so it may be taller.
        const spans = slot.dataset.heights.split(",").map(Number).concat(single && slot.classList.contains("size-l") ? [5] : []);
        const card = body.parentElement!;
        const natural = () => {
          card.style.height = "auto";
          const h = card.getBoundingClientRect().height;
          card.style.height = "";
          return h;
        };
        for (const span of spans) {
          slot.style.gridRowEnd = `span ${span}`;
          full();
          text(2);
          if (natural() <= slot.getBoundingClientRect().height + 1) break;
        }
      }
      if (!(text(2) || list(2) || text(1) || list(1))) body.classList.add("cut");
      for (const l of lists) {
        const more = l.nextElementSibling as HTMLElement | null;
        if (!more?.classList.contains("c-more")) continue;
        const n = Number(l.dataset.more ?? 0) + l.children.length - shown(l).length;
        more.textContent = `${n} more`;
        more.hidden = n === 0;
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
  const body = useFit(expanded);
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
  const labelNode = label ?? (namesOwnMatter(card) ? null : <a href={`#thread/${card.threadId}`}>{card.threadTitle}</a>);
  // A ready card with nothing to label needs no head: an empty line with only a time in it is noise.
  const quiet = !card.running && (card.status === "ready" || (Boolean(board?.grouped) && (card.status === "needs_you" || card.status === "watching")));
  // Nor does a head with nothing in it at all (a card needing the owner, or one being worked on): it would only push the title down.
  const empty = labelNode === null && !statusShown(card, board?.grouped);
  const head = label !== null && !(labelNode === null && quiet) && !empty;
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
            <Status card={card} grouped={board?.grouped} />
            {actions}
          </span>
        </header>
      ) : actions ? (
        <span className="vcard-corner floating">{actions}</span>
      ) : null}
      <div className="vcard-body" ref={body}>
        {children}
      </div>
      <Pulse card={card} live={Boolean(board) && !expanded} />
      {own ? <footer className="vcard-foot">{own}</footer> : null}
    </article>
  );
}

/**
 * The thread's name labels a card only when it adds something: "Weekend"
 * over "Tokyo or Seoul in November" does, "Inbox" over "Inbox tidied" does not.
 */
function namesOwnMatter(card: Card): boolean {
  const thread = card.threadTitle.trim().toLowerCase();
  const title = card.title.toLowerCase();
  if (!thread || title.includes(thread) || thread.includes(title)) return true;
  return thread.split(/[\s,·:/-]+/).some((w) => w.length >= 3 && title.includes(w));
}

const CHANGE_WINDOW = 36 * 3600e3;

/**
 * One line between the body and the buttons that says what moved: while the
 * matter is worked on, the step Vireo is on; after an update, the facts it
 * changed ("Return ¥2,202 → ¥2,137"), for a day and a half.
 */
function Pulse({ card, live }: { card: Card; live: boolean }) {
  // The peek and the thread page say what Vireo is doing in their own place.
  if (card.running && !live) return null;
  if (card.running) {
    const now = nowLine(card.statusLine ?? (card.kind === "thread" ? field(card, "statusLine", "") : ""));
    return (
      <p className="vcard-pulse working" data-testid="card-step">
        <Eyes state="working" />
        {now ? <span className="vcard-pulse-text">{now}</span> : null}
      </p>
    );
  }
  if (card.kind === "thread") return null;
  const changes = card.changes ?? [];
  if (!changes.length || Date.now() - card.updatedAt > CHANGE_WINDOW) return null;
  return (
    <p className="vcard-pulse changed" data-testid="card-changes">
      {changes.map((c, i) => (
        <span key={i} className="vcard-change">
          <span className="what">{c.label}</span>
          <s>{c.from}</s>
          <span className="arrow" aria-label="now">→</span>
          <b>{c.to}</b>
        </span>
      ))}
    </p>
  );
}

/** Whether Status draws anything for this card. */
function statusShown(card: Card, grouped?: boolean): boolean {
  // Working shows once, as the eyes on the card's step line; on the board the heading says the rest, and the peek says when it moved.
  if (card.running || card.status === "working") return false;
  if (grouped) return false;
  // Needs you is said by where the card sits (the board's heading, the peek's head, the thread's status), not on the card.
  return card.status !== "needs_you";
}

export function Status({ card, grouped }: { card: Card; grouped?: boolean }) {
  if (!statusShown(card, grouped)) return null;
  if (card.status === "watching") return <span className="vcard-status watching">Watching</span>;
  if (card.status === "done") return <span className="vcard-status done">Done</span>;
  return <span className="vcard-status quiet">{relTime(card.updatedAt)}</span>;
}

export function Buttons({ card, buttons }: { card: Card; buttons: CardButton[] }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [sent, setSent] = useState("");
  const [failed, setFailed] = useState(false);
  // A new version of the card brings its own buttons; the last answer was to the old one.
  const seen = useRef(card.updatedAt);
  useEffect(() => {
    if (card.updatedAt === seen.current) return;
    seen.current = card.updatedAt;
    setSent("");
  }, [card.updatedAt]);
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
          type="button"
          className={`cbtn ${b.primary || (i === 0 && buttons.length > 0 && !buttons.some((x) => x.primary)) ? "primary" : ""}`}
          disabled={busy !== null}
          aria-busy={busy === i}
          onClick={(e) => {
            // The answer is the whole action: the card around it does not open too.
            e.stopPropagation();
            setBusy(i);
            setFailed(false);
            void pressButton(card, b)
              .then(() => b.reply && setSent(b.label))
              .catch(() => setFailed(true))
              .finally(() => setBusy(null));
          }}
        >
          {b.label}
        </button>
      ))}
      {failed ? (
        <span className="vcard-error" role="alert" data-testid="card-send-failed">
          Couldn't send that. Try again.
        </span>
      ) : null}
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
