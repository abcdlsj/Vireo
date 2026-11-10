import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { api } from "../api";
import type { Card, CardButton } from "@vireo/protocol";

/**
 * Every card kind is one file in ./kinds that default-exports defineCard({...}).
 * Files are picked up automatically, so adding a kind means adding that file
 * (and its data shape in apps/node/src/cards/kinds.ts); nothing else changes.
 *
 * Three kinds are on the first screen (a matter's answer, the general card and
 * the fallback) and ship with the app; the rest are fetched the first time a
 * card of that kind is drawn, so a phone does not download a boarding pass and
 * a pull request to show a note.
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

/**
 * The board geometry of the kinds loaded on demand. Their own file is the
 * source of truth; this copy exists because the board must know how wide and
 * tall a card is before its code has arrived. A kind that changes its size
 * must change it here too (the check below says so in development).
 */
const BOARD: Record<string, { size?: CardSize | ((card: Card) => CardSize); height?: CardHeight }> = {
  flight: { size: "l" },
  trip: { size: "l" },
  event: { size: "l" },
  email: { size: "l" },
  compare: { size: "l" },
  // An invite and an email have a page of their own; any other action is a line.
  proposal: { size: (card) => (["create_event", "send_email"].includes(String(card.data.tool)) ? "l" : "s") },
  reminder: { height: "medium" },
};

/** The three kinds on the first screen; every other kind is a file loaded the first time it is drawn. */
const FIRST_SCREEN = ["./kinds/thread.tsx", "./kinds/card.tsx", "./kinds/fallback.tsx"];
const EAGER = import.meta.glob<{ default: CardKindView }>(FIRST_SCREEN, { eager: true });
const ON_DEMAND = import.meta.glob<{ default: CardKindView }>(["./kinds/*.tsx", ...FIRST_SCREEN.map((p) => `!${p}`)]);

const KINDS = new Map(Object.values(EAGER).map((m) => [m.default.kind, m.default]));
const LAZY = new Map<string, CardKindView>();

/** Says which kind is missing from BOARD, or lies about its geometry, while developing. */
function checkBoard(kind: string, view: CardKindView): void {
  if (!import.meta.env.DEV) return;
  const known = BOARD[kind];
  const size = typeof view.size === "function" ? undefined : view.size;
  if ((size ?? "s") !== (known?.size ?? "s") || (view.height ?? "auto") !== (known?.height ?? "auto")) {
    console.warn(`registry: ${kind} is ${size ?? "s"}/${view.height ?? "auto"} in its file; add or fix it in BOARD.`);
  }
}

/** A card whose code is on its way: the frame it will land in, without the content. */
function Loading({ card }: { card: Card }) {
  return (
    <article className="vcard c-loading" aria-busy="true" data-kind={card.kind}>
      <span className="c-loading-line wide" />
      <span className="c-loading-line" />
    </article>
  );
}

function onDemand(kind: string): CardKindView | undefined {
  const loader = ON_DEMAND[`./kinds/${kind}.tsx`];
  if (!loader) return undefined;
  const had = LAZY.get(kind);
  if (had) return had;
  const Body = lazy(() =>
    loader().then((m) => {
      checkBoard(kind, m.default);
      return { default: ((p: { card: Card; expanded: boolean; refresh: () => void }) => <>{m.default.render(p)}</>) as ComponentType<{ card: Card; expanded: boolean; refresh: () => void }> };
    }),
  );
  const view: CardKindView = {
    kind,
    ...BOARD[kind],
    render: (props) => (
      <Suspense fallback={<Loading card={props.card} />}>
        <Body {...props} />
      </Suspense>
    ),
  };
  LAZY.set(kind, view);
  return view;
}

export function cardView(kind: string): CardKindView {
  return KINDS.get(kind) ?? onDemand(kind) ?? KINDS.get("fallback")!;
}

/** Runs a card button: a reply goes to the card's thread as the owner's message; a url opens. */
export async function pressButton(card: Card, b: CardButton): Promise<void> {
  if (b.reply) await api.post(`/api/threads/${card.threadId}/messages`, { text: b.reply });
  else if (b.url) window.open(b.url, "_blank", "noopener,noreferrer");
}
