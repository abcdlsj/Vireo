import { Type } from "typebox";
import { Value } from "typebox/value";
import { CARD_KIND_NAMES, CARD_KINDS, cardKind } from "../cards/kinds.js";
import type { CardStatus } from "../cards/store.js";
import { OVERVIEW_ID } from "../threads.js";
import { defineTool } from "./types.js";

/**
 * A compact, model-readable outline of a kind's data with its limits, e.g.
 * `{ text: ≤600, sources?: [{ title: ≤80, url }] ≤5 }`.
 */
export function shapeOf(schema: unknown): string {
  const s = schema as { type?: string; properties?: Record<string, unknown>; required?: string[]; items?: unknown; anyOf?: { const?: unknown }[]; maxLength?: number; maxItems?: number };
  if (s.anyOf) return s.anyOf.map((o) => JSON.stringify(o.const)).join("|");
  if (s.type === "array") return `[${shapeOf(s.items)}]${s.maxItems ? ` ≤${s.maxItems}` : ""}`;
  if (s.type === "object" && s.properties) {
    const required = new Set(s.required ?? []);
    const fields = Object.entries(s.properties).map(([k, v]) => {
      const inner = shapeOf(v);
      return `${k}${required.has(k) ? "" : "?"}${inner ? `: ${inner}` : ""}`;
    });
    return `{ ${fields.join(", ")} }`;
  }
  if (s.type === "string") return s.maxLength && s.maxLength < 1000 ? `≤${s.maxLength}` : "";
  return s.type ?? "";
}

const TITLE_MAX = 60;

const STATUSES = ["working", "needs_you", "watching", "ready", "done"] as const;

export const cardTools = [
  defineTool({
    name: "show_card",
    label: "Show card",
    description: [
      "Show the result of this matter as a card on the owner's home page, or update a card you showed before (pass card_id).",
      "Cards are what the owner looks at; keep your chat reply to a sentence or two and put the substance in the card.",
      "Update the same card as the matter moves on (searching → options → booked) instead of adding new ones.",
      "Do not use it for confirmations: outward actions show their own confirmation card.",
      "Status: working (still on it), needs_you (waiting on the owner), watching (you keep checking it), ready (a result to look at), done (finished, kept for the record).",
      "Buttons send their reply text to this thread as if the owner had typed it, or open a url.",
      "Cards are glanced at, not read. Make the point obvious: a title of a few words, one fact per field, numbers only in value/price fields, never the same fact in two fields. Leave reasoning and caveats to your chat reply. Text limits (≤N characters) and list limits are enforced.",
      "Kinds and their data:",
      ...CARD_KINDS.map((k) => `- ${k.name}: ${k.description} data ${shapeOf(k.data)}`),
    ].join("\n"),
    parameters: Type.Object({
      card_id: Type.Optional(Type.String({ description: "The id of a card in this thread to update" })),
      kind: Type.Union(CARD_KIND_NAMES.map((n) => Type.Literal(n))),
      title: Type.String({ description: `A few words naming the matter, at most ${TITLE_MAX} characters, e.g. 'Shanghai ⇄ Tokyo, Oct 10'` }),
      status: Type.Optional(Type.Union(STATUSES.map((s) => Type.Literal(s)))),
      data: Type.Record(Type.String(), Type.Unknown()),
      buttons: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String(),
            reply: Type.Optional(Type.String()),
            url: Type.Optional(Type.String()),
            primary: Type.Optional(Type.Boolean()),
          }),
          { maxItems: 3 },
        ),
      ),
    }),
    async run(args, ctx) {
      if (ctx.thread.id === OVERVIEW_ID) throw new Error("Cards belong to a matter: call open_thread first and show the card from there.");
      const kind = cardKind(args.kind);
      if (!kind) throw new Error(`Unknown kind "${args.kind}". Use one of: ${CARD_KIND_NAMES.join(", ")}.`);
      if ([...args.title].length > TITLE_MAX) throw new Error(`The title is too long (${[...args.title].length} characters, at most ${TITLE_MAX}). Name the matter in a few words.`);
      if (!Value.Check(kind.data, args.data)) {
        const problems = [...Value.Errors(kind.data, args.data)].slice(0, 5).map((e) => `${e.instancePath || "data"} ${e.message}`);
        throw new Error(`The data does not fit a ${kind.name} card: ${problems.join("; ")}. Expected ${shapeOf(kind.data)}.`);
      }
      const buttons = (args.buttons ?? []).filter((b) => b.reply || (b.url && /^https?:\/\//.test(b.url)));
      const card = ctx.app.cards.save(ctx.thread.id, {
        id: args.card_id,
        kind: kind.name,
        title: args.title,
        status: (args.status ?? "ready") as CardStatus,
        data: args.data,
        buttons,
      });
      return { text: `Card ${card.id} is on the owner's home page. To change it later, call show_card with card_id "${card.id}".` };
    },
  }),
];
