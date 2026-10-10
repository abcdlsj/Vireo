import type { ReactNode } from "react";
import { api } from "../api";
import type { Card, CardButton } from "@vireo/protocol";

/**
 * Every card kind is one file in ./kinds that default-exports defineCard({...}).
 * Files are picked up automatically, so adding a kind means adding that file
 * (and its data shape in apps/host/src/cards/kinds.ts); nothing else changes.
 */
export interface CardKindView {
  kind: string;
  /** Spans two columns on the home grid; a function decides per card. */
  wide?: boolean | ((card: Card) => boolean);
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
