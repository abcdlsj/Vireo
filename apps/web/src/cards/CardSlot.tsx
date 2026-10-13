import { cardView } from "./registry";
import type { Card } from "@vireo/protocol";

/** One card on the board (at its fixed size, small or large) or on its thread's page (expanded). */
export function CardSlot({ card, expanded = false, refresh }: { card: Card; expanded?: boolean; refresh: () => void }) {
  const view = cardView(card.kind);
  const size = (typeof view.size === "function" ? view.size(card) : view.size) ?? "s";
  return <div className={`slot size-${size}`}>{view.render({ card, expanded, refresh })}</div>;
}
