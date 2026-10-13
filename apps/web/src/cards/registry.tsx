import type { ReactNode } from "react";
import { api } from "../api";
import type { Card, CardButton } from "@vireo/protocol";

/**
 * Every card kind is one file in ./kinds that default-exports defineCard({...}).
 * Files are picked up automatically, so adding a kind means adding that file
 * (and its data shape in apps/node/src/cards/kinds.ts); nothing else changes.
 */
export type CardSize = "s" | "l";
export type CardHeight = "short" | "medium" | "tall" | "auto";

export interface CardKindView {
  kind: string;
  /**
   * The card's width on the board: small (one column) or large (two columns).
   * Small by default; a function decides per card.
   */
  size?: CardSize | ((card: Card) => CardSize);
  /**
   * The height the card takes on the board: short, medium or tall (cards.css).
   * By default the board picks the shortest that holds the content; a kind
   * whose cards should all match picks one.
   */
  height?: CardHeight;
  /** Renders the card. `expanded` is the card's own page, where it can show everything. */
  render: (props: { card: Card; expanded: boolean; refresh: () => void }) => ReactNode;
}

export function defineCard(view: CardKindView): CardKindView {
  return view;
}

const modules = import.meta.glob<{ default: CardKindView }>("./kinds/*.tsx", { eager: true });
const KINDS = new Map(Object.values(modules).map((m) => [m.default.kind, m.default]));

export function cardView(kind: string): CardKindView {
  return KINDS.get(kind) ?? KINDS.get("fallback")!;
}

/** Runs a card button: a reply goes to the card's thread as the owner's message; a url opens. */
export async function pressButton(card: Card, b: CardButton): Promise<void> {
  if (b.reply) await api.post(`/api/threads/${card.threadId}/messages`, { text: b.reply });
  else if (b.url) window.open(b.url, "_blank", "noopener,noreferrer");
}
