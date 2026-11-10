import { cardView } from "./registry";
import type { Card } from "@vireo/protocol";

/**
 * One card on the board (small or large, short or tall) or on its thread's
 * page (expanded). `natural` lets a board card keep its own height instead of
 * taking a number of rows: for the one column that waits on the owner.
 */
export function CardSlot({ card, expanded = false, refresh, natural = false }: { card: Card; expanded?: boolean; refresh: () => void; natural?: boolean }) {
  const view = cardView(card.kind);
  const size = (typeof view.size === "function" ? view.size(card) : view.size) ?? "s";
  // Heights in board rows (cards.css): short is two, medium three, tall four.
  const heights = { short: "2", medium: "3", tall: "4", auto: "2,3,4" }[view.height ?? "auto"];
  return (
    <div className={`slot size-${size}`} data-heights={expanded || natural ? undefined : heights}>
      {view.render({ card, expanded, refresh })}
    </div>
  );
}
