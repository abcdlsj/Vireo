export type CardStatus = "working" | "needs_you" | "watching" | "ready" | "done";

export interface CardChange {
  label: string;
  from: string;
  to: string;
}

export interface CardButton {
  label: string;
  reply?: string;
  url?: string;
  primary?: boolean;
}

/** Mirrors server/src/cards/store.ts. `data` is shaped by the kind. */
export interface Card {
  id: string;
  threadId: string;
  threadTitle: string;
  kind: string;
  title: string;
  status: CardStatus;
  data: Record<string, unknown>;
  buttons: CardButton[];
  running: boolean;
  /** What the thread is doing right now, while it runs. */
  statusLine?: string;
  /** Facts the last update changed. */
  changes: CardChange[];
  createdAt: number;
  updatedAt: number;
}

/** Reads a field of a card's data with a fallback, since the data comes from the model. */
export function field<T>(card: Card, key: string, fallback: T): T {
  const v = card.data[key];
  if (v === undefined || v === null) return fallback;
  if (Array.isArray(fallback) && !Array.isArray(v)) return fallback;
  if (typeof fallback === "string" && typeof v !== "string") return String(v) as T;
  if (typeof fallback === "number" && typeof v !== "number") return (Number(v) || fallback) as T;
  return v as T;
}
