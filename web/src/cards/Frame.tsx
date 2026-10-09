import { useState, type MouseEvent, type ReactNode } from "react";
import { relTime } from "../format";
import { go } from "../route";
import { pressButton } from "./registry";
import type { Card, CardButton } from "./types";

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
  const open = (e: MouseEvent) => {
    if (expanded) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    go(`thread/${card.threadId}`);
  };
  const own = buttons ?? (card.buttons.length ? <Buttons card={card} buttons={card.buttons} /> : null);
  return (
    <article
      className={`vcard tone-${tone} ${expanded ? "expanded" : ""} ${flush ? "flush" : ""} ${card.status} ${className ?? ""}`}
      onClick={open}
      data-testid="card"
      data-kind={card.kind}
      data-status={card.status}
    >
      {label !== null ? (
        <header className="vcard-head">
          <span className="vcard-label">
            {label ?? (card.threadTitle && card.threadTitle !== card.title ? <a href={`#thread/${card.threadId}`}>{card.threadTitle}</a> : null)}
          </span>
          <Status card={card} />
        </header>
      ) : null}
      <div className="vcard-body">{children}</div>
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
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState("");
  if (sent) return <span className="vcard-sent">Sent “{sent}”</span>;
  return (
    <div className="vcard-buttons">
      {buttons.map((b, i) => (
        <button
          key={i}
          className={`cbtn ${b.primary || (i === 0 && buttons.length > 0 && !buttons.some((x) => x.primary)) ? "primary" : ""}`}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void pressButton(card, b)
              .then(() => b.reply && setSent(b.label))
              .finally(() => setBusy(false));
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
