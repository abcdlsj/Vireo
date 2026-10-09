import { Type, type TSchema } from "typebox";

/**
 * A card is a title, a status and a few blocks. Blocks are a small, fixed
 * vocabulary of general shapes (key numbers, rows, a short text, steps, a
 * chart, links); the model composes any matter out of them, and the web app
 * draws each block one way, so every card looks finished without code for
 * any one scenario.
 *
 * Cards are glanced at, not read, so every text has a length limit and every
 * list a size limit. Data over a limit is refused and the model has to say it
 * shorter; the full story belongs in the chat.
 */
export interface BlockKind {
  type: string;
  /** Tells the model what the block is for. */
  description: string;
  schema: TSchema;
}

const Str = (max: number, description?: string) => Type.String({ maxLength: max, ...(description ? { description } : {}) });
const Opt = <T extends TSchema>(t: T) => Type.Optional(t);
const List = <T extends TSchema>(t: T, max: number, description?: string) =>
  Type.Array(t, { maxItems: max, minItems: 1, ...(description ? { description } : {}) });
const Url = Type.String({ maxLength: 2000 });
const Lit = (s: string) => Type.Literal(s);

export const MARKS = ["picked", "best", "attention", "done"] as const;

export const BLOCK_KINDS: BlockKind[] = [
  {
    type: "facts",
    description: "The few numbers or values that decide, big: prices, totals, counts, a date.",
    schema: Type.Object({
      type: Lit("facts"),
      items: List(
        Type.Object({
          value: Str(16, "e.g. '¥804', '42', 'Oct 14'"),
          label: Str(24, "What the value is, e.g. 'Archived'"),
          tone: Opt(Type.Union([Lit("good"), Lit("attention")])),
        }),
        4,
      ),
    }),
  },
  {
    type: "rows",
    description: "A short list of things of one sort: options to choose from, items handled, emails, files, people, places. Mark the one picked or best.",
    schema: Type.Object({
      type: Lit("rows"),
      items: List(
        Type.Object({
          lead: Opt(Str(8, "A short tag or time before the title, e.g. '09:30', 'New'")),
          title: Str(48, "The thing's name, e.g. 'Park Hyatt Tokyo'"),
          detail: Opt(Str(64, "One or two facts that tell it apart, e.g. 'Shinjuku · 4.6 ★'")),
          value: Opt(Str(16, "The number that decides, e.g. '¥2,400'")),
          mark: Opt(Type.Union(MARKS.map(Lit), { description: "picked (chosen), best (recommended), attention (needs the owner), done" })),
          url: Opt(Url),
        }),
        6,
      ),
    }),
  },
  {
    type: "text",
    description: "A direct answer or a short passage, when the point is words rather than numbers.",
    schema: Type.Object({
      type: Lit("text"),
      text: Str(500, "Markdown. Lead with the conclusion; one short paragraph after it at most"),
    }),
  },
  {
    type: "steps",
    description: "Stages of something that moves forward: a delivery, an application, a booking.",
    schema: Type.Object({
      type: Lit("steps"),
      items: List(Str(20, "A word or two"), 6),
      current: Type.Number({ description: "Index of the current stage" }),
    }),
  },
  {
    type: "chart",
    description: "How a number moves: a price over days (line), or one value per option or date (bars).",
    schema: Type.Object({
      type: Lit("chart"),
      style: Opt(Type.Union([Lit("line"), Lit("bars")])),
      values: List(Type.Number(), 30, "Oldest or first first"),
      labels: Opt(List(Str(8), 30, "One per value, for bars, e.g. '10/19'")),
      caption: Opt(Str(48, "What the chart shows, e.g. 'Cheapest return per day'")),
      highlight: Opt(Type.Number({ description: "Index of the value to pick out, e.g. the cheapest" })),
    }),
  },
  {
    type: "links",
    description: "Sources or pages worth opening.",
    schema: Type.Object({
      type: Lit("links"),
      items: List(Type.Object({ title: Str(64), url: Url }), 5),
    }),
  },
];

export const BLOCK_TYPES = BLOCK_KINDS.map((b) => b.type);

export function blockKind(type: unknown): BlockKind | undefined {
  return BLOCK_KINDS.find((b) => b.type === type);
}

/** Every new card is stored with this kind; older cards keep the kinds they were made with. */
export const CARD_KIND = "card";
