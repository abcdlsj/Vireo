import type { ReactNode } from "react";
import { CheckIcon } from "../../icons";
import { Markdown } from "../../markdown";
import { Frame, Sparkline, hostOf } from "../Frame";
import { defineCard } from "../registry";
import type { Card } from "../types";
import { field } from "../types";
import { isHttp } from "../util";

/** Mirrors server/src/cards/blocks.ts. Every field comes from the model, so each is read defensively. */
type Mark = "picked" | "best" | "attention" | "done";
type Block =
  | { type: "facts"; items?: { value?: string; label?: string; tone?: "good" | "attention" }[] }
  | { type: "rows"; items?: { lead?: string; title?: string; detail?: string; value?: string; mark?: Mark; url?: string }[] }
  | { type: "text"; text?: string }
  | { type: "steps"; items?: string[]; current?: number }
  | { type: "chart"; style?: "line" | "bars"; values?: number[]; labels?: string[]; caption?: string; highlight?: number }
  | { type: "links"; items?: { title?: string; url?: string }[] };

const MARK_LABEL: Record<Mark, string> = { picked: "Picked", best: "Best", attention: "Needs you", done: "Done" };

/** How much room a card's blocks want; heavy cards span two columns on the board. */
function weight(blocks: Block[]): number {
  let w = 0;
  for (const b of blocks) {
    if (b.type === "facts") w += 2;
    else if (b.type === "rows") w += (b.items?.length ?? 0) * (b.items?.some((i) => i.detail) ? 1.2 : 0.8);
    else if (b.type === "text") w += Math.min(4, (b.text?.length ?? 0) / 120);
    else if (b.type === "chart") w += b.style === "bars" && (b.values?.length ?? 0) > 7 ? 4 : 2;
    else w += 1.5;
  }
  return w;
}

/**
 * The general card: a title, an optional line under it, and up to four
 * blocks drawn from one small vocabulary. It is how Vireo shows anything that
 * has no kind of its own, so each block is drawn with care once and every
 * such card comes out the same: quiet type, numbers that line up, one accent.
 */
export default defineCard({
  kind: "card",
  wide: (card) => weight(field<Block[]>(card, "blocks", [])) > 6,
  render: ({ card, expanded }) => {
    const subtitle = field(card, "subtitle", "");
    const blocks = field<Block[]>(card, "blocks", []).filter((b) => b && typeof b === "object");
    return (
      <Frame card={card} expanded={expanded} className="gcard">
        <div className="g-head">
          <h3 className="c-title">{card.title}</h3>
          {subtitle ? <p className="c-sub">{subtitle}</p> : null}
        </div>
        {blocks.map((b, i) => (
          <BlockView key={i} block={b} card={card} expanded={expanded} />
        ))}
      </Frame>
    );
  },
});

function BlockView({ block, expanded }: { block: Block; card: Card; expanded: boolean }): ReactNode {
  switch (block.type) {
    case "facts":
      return <Facts items={block.items ?? []} />;
    case "rows":
      return <Rows items={block.items ?? []} />;
    case "text":
      return block.text ? (
        <div className="g-text fade">
          <Markdown text={block.text} />
        </div>
      ) : null;
    case "steps":
      return <Steps items={block.items ?? []} current={block.current ?? 0} />;
    case "chart":
      return <Chart block={block} expanded={expanded} />;
    case "links":
      return <Links items={block.items ?? []} />;
    default:
      return null;
  }
}

function Facts({ items }: { items: NonNullable<Extract<Block, { type: "facts" }>["items"]> }) {
  const shown = items.filter((f) => f.value).slice(0, 4);
  if (!shown.length) return null;
  return (
    <dl className="g-facts" style={{ ["--n" as string]: shown.length }}>
      {shown.map((f, i) => (
        <div key={i} className={f.tone ?? ""}>
          <dd>{f.value}</dd>
          <dt>{f.label}</dt>
        </div>
      ))}
    </dl>
  );
}

function Rows({ items }: { items: NonNullable<Extract<Block, { type: "rows" }>["items"]> }) {
  const shown = items.filter((r) => r.title);
  if (!shown.length) return null;
  const leads = shown.some((r) => r.lead);
  return (
    <ul className={`g-rows c-rows ${leads ? "with-lead" : ""}`}>
      {shown.map((r, i) => {
        const title = isHttp(r.url) ? (
          <a href={r.url} target="_blank" rel="noreferrer">
            {r.title}
          </a>
        ) : (
          r.title
        );
        return (
          <li key={i} className={r.mark ? `mark-${r.mark}` : ""}>
            {leads ? <span className="g-lead">{r.lead}</span> : null}
            <span className="g-main">
              <span className="g-title">
                {r.mark === "picked" || r.mark === "done" ? <CheckIcon /> : null}
                {/* Several rows can need the owner at once; a dot says so without a word repeated down the list. */}
                {r.mark === "attention" ? <span className="g-attn" role="img" aria-label={MARK_LABEL.attention} title={MARK_LABEL.attention} /> : null}
                <span className="g-name">{title}</span>
                {r.mark === "best" ? <span className="g-mark">{MARK_LABEL.best}</span> : null}
              </span>
              {r.detail ? <span className="g-detail">{r.detail}</span> : null}
            </span>
            {r.value ? <span className="g-value">{r.value}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

function Steps({ items, current }: { items: string[]; current: number }) {
  if (!items.length) return null;
  const now = Math.max(0, Math.min(items.length - 1, Math.round(current)));
  return (
    <div className="stages">
      <div className="stage-line" style={{ ["--p" as string]: `${items.length > 1 ? (now / (items.length - 1)) * 100 : 0}%` }}>
        {items.map((_, i) => (
          <span key={i} className={`stage-dot ${i < now ? "past" : i === now ? "now" : ""}`} />
        ))}
      </div>
      <div className="stage-labels">
        {items.map((s, i) => (
          <span key={i} className={i === now ? "now" : ""}>
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

function Chart({ block, expanded }: { block: Extract<Block, { type: "chart" }>; expanded: boolean }) {
  const values = (block.values ?? []).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (values.length < 2) return null;
  if (block.style !== "bars") {
    return (
      <figure className="g-chart is-line">
        <div className="accent-ink">
          <Sparkline values={values} height={48} />
        </div>
        {block.caption ? <figcaption>{block.caption}</figcaption> : null}
      </figure>
    );
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const labels = block.labels ?? [];
  return (
    <figure className="g-chart is-bars">
      <div className="g-bars" role="list">
        {values.map((v, i) => (
          <span key={i} role="listitem" className={`g-bar ${i === block.highlight ? "hi" : ""}`} title={`${labels[i] ?? ""} ${v}`.trim()}>
            <span className="g-bar-fill" style={{ height: `${max > min ? 18 + ((v - min) / (max - min)) * 82 : 60}%` }} />
            {labels[i] ? <span className="g-bar-label">{labels[i]}</span> : null}
          </span>
        ))}
      </div>
      {block.caption ? <figcaption>{block.caption}</figcaption> : null}
    </figure>
  );
}

function Links({ items }: { items: NonNullable<Extract<Block, { type: "links" }>["items"]> }) {
  const shown = items.filter((l) => isHttp(l.url));
  if (!shown.length) return null;
  return (
    <ul className="g-links c-rows">
      {shown.map((l, i) => (
        <li key={i}>
          <a href={l.url} target="_blank" rel="noreferrer">
            <span className="g-name">{l.title || hostOf(l.url!)}</span>
            <span className="g-host">{hostOf(l.url!)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
