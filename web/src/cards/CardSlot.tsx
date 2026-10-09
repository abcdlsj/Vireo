import { cardView } from "./registry";
import type { Card } from "./types";

/** One card on the board (fixed size, wide kinds span two columns) or on its thread's page (expanded). */
export function CardSlot({ card, expanded = false, refresh }: { card: Card; expanded?: boolean; refresh: () => void }) {
  const view = cardView(card.kind);
  return <div className={`slot ${view.wide ? "wide" : ""}`}>{view.render({ card, expanded, refresh })}</div>;
}
