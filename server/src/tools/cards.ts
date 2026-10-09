import { Type } from "typebox";
import { Value } from "typebox/value";
import { BLOCK_KINDS, blockKind } from "../cards/blocks.js";
import { CARD_KIND_NAMES, CARD_KINDS, cardKind, type CardKind } from "../cards/kinds.js";
import type { CardStatus } from "../cards/store.js";
import { OVERVIEW_ID } from "../threads.js";
import { toZonedIso, zonedToUtc } from "../time.js";
import { defineTool } from "./types.js";

/**
 * A compact, model-readable outline of a kind's data with its limits and the
 * hint each field carries, e.g.
 * `{ text: ≤600 "Markdown", sources?: [{ title: ≤80, url }] ≤5 }`.
 */
export function shapeOf(schema: unknown, seen = new Map<unknown, string>()): string {
  const s = schema as { type?: string; properties?: Record<string, unknown>; required?: string[]; items?: unknown; anyOf?: { const?: unknown }[]; maxLength?: number; maxItems?: number; description?: string };
  if ((s as { const?: unknown }).const !== undefined) return JSON.stringify((s as { const?: unknown }).const);
  if (s.anyOf) return s.anyOf.map((o) => JSON.stringify(o.const)).join("|");
  if (s.type === "array") return `[${shapeOf(s.items, seen)}]${s.maxItems ? ` ≤${s.maxItems}` : ""}`;
  if (s.type === "object" && s.properties) {
    const required = new Set(s.required ?? []);
    const fields = Object.entries(s.properties).map(([k, v]) => {
      // A shape used twice (a round trip's two legs) is spelled out once.
      const key = (v as { type?: string }).type === "object" ? JSON.stringify(v) : undefined;
      const inner = key && seen.has(key) ? `same as ${seen.get(key)}` : shapeOf(v, seen);
      if (key && !seen.has(key)) seen.set(key, k);
      const hint = (v as { description?: string }).description;
      return `${k}${required.has(k) ? "" : "?"}${inner ? `: ${inner}` : ""}${hint ? ` "${hint}"` : ""}`;
    });
    return `{ ${fields.join(", ")} }`;
  }
  if (s.type === "string") return s.maxLength && s.maxLength < 1000 ? `≤${s.maxLength}` : "";
  return s.type ?? "";
}

const TITLE_MAX = 40;
const LABEL_MAX = 16;

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
const TIME_ONLY = /^(\d{1,2}):(\d{2})$/;

/**
 * Forgives what models commonly get slightly wrong, so a card is not refused
 * (and a turn spent) over form: data sent as a JSON string, numbers where text
 * is expected, and times like "2026-10-14 15:30" or an end of just "16:15",
 * which become ISO 8601 in the owner's time zone.
 */
export function normalizeData(kind: CardKind, raw: unknown, timeZone: string): Record<string, unknown> {
  let data = raw;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      // Left as is; the check below explains what was expected.
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return data as Record<string, unknown>;
  const out = Value.Convert(kind.data, structuredClone(data)) as Record<string, unknown>;
  let day: string | undefined;
  for (const key of kind.times ?? []) {
    const v = out[key];
    if (typeof v !== "string") continue;
    const m = v.trim().match(DATE_TIME);
    const t = v.trim().match(TIME_ONLY);
    if (m) {
      const [, date, h, min, sec, off] = m;
      day ??= date;
      if (h === undefined) continue;
      if (off) {
        out[key] = `${date}T${h.padStart(2, "0")}:${min}:${sec ?? "00"}${off === "Z" ? "Z" : off.replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2")}`;
      } else {
        const [y, mo, d] = date!.split("-").map(Number);
        out[key] = toZonedIso(zonedToUtc(y!, mo!, d!, Number(h), Number(min), timeZone), timeZone);
      }
    } else if (t && day) {
      // An end time on the same day as the start.
      const start = typeof out[kind.times![0]!] === "string" ? (out[kind.times![0]!] as string) : "";
      const off = start.match(/(Z|[+-]\d{2}:\d{2})$/)?.[1];
      const [y, mo, d] = day.split("-").map(Number);
      out[key] = off
        ? `${day}T${t[1]!.padStart(2, "0")}:${t[2]}:00${off}`
        : toZonedIso(zonedToUtc(y!, mo!, d!, Number(t[1]), Number(t[2]), timeZone), timeZone);
    }
  }
  return out;
}

const STATUSES = ["working", "needs_you", "watching", "ready", "done"] as const;

/** Checks each block against its own type, so a mistake is reported where it is. */
function checkBlocks(blocks: unknown[]): void {
  blocks.forEach((raw, i) => {
    const type = (raw as { type?: unknown })?.type;
    const kind = blockKind(type);
    if (!kind) throw new Error(`blocks/${i} has an unknown type ${JSON.stringify(type)}. Use one of: ${BLOCK_KINDS.map((b) => b.type).join(", ")}.`);
    const block = Value.Convert(kind.schema, raw);
    blocks[i] = block;
    if (!Value.Check(kind.schema, block)) {
      const problems = [...Value.Errors(kind.schema, block)].slice(0, 5).map((e) => `blocks/${i}${e.instancePath} ${e.message}`);
      throw new Error(`Block ${i} does not fit a ${kind.type} block: ${problems.join("; ")}. Expected ${shapeOf(kind.schema)}.`);
    }
  });
}

export const cardTools = [
  defineTool({
    name: "show_card",
    label: "Show card",
    description: [
      "Show the result of this matter as a card on the owner's home page, or update a card you showed before (pass card_id).",
      "Cards are what the owner looks at; keep your chat reply to a sentence or two and put the substance in the card.",
      "Update the same card as the matter moves on (searching → options → booked) instead of adding new ones.",
      "Do not use it for confirmations: outward actions show their own confirmation card.",
      "Status: ready (a result for the owner to look at: the default, and right for most answers), needs_you (the owner has to decide or reply), watching (you keep checking it), working (still on it), done (the matter is over, e.g. the trip was taken or the parcel arrived; done cards leave the home board, so never mark a fresh result done).",
      "Buttons send their reply text to this thread as if the owner had typed it, or open a url.",
      "Pick a kind made for the matter when there is one (a flight → flight, flights there and back → trip, a calendar event → event, an email → email, a place → place, a pull request → github_pr, something you keep checking → watch, something to keep → document). Everything else is a card made of blocks.",
      "Cards are glanced at, not read. A card holds facts only: one fact per field, numbers only in value/price fields, never the same fact twice. Checklists, questions to the owner, reasoning, caveats and reminders go in your chat reply, never in the card. Buttons are the next steps, labelled in two or three words. Text limits (≤N characters) and list limits are enforced.",
      "Kinds and their data:",
      ...CARD_KINDS.map((k) => `- ${k.name}: ${k.description} data ${shapeOf(k.data)}`),
      "Blocks of a card (each has its type):",
      ...BLOCK_KINDS.map((b) => `- ${b.type}: ${b.description} ${shapeOf(b.schema)}`),
      'Example: an answer with sources is blocks [{ type: "text", text: "…" }, { type: "links", items: [{ title, url }] }]; hotels to choose from are [{ type: "rows", items: [{ title, detail, value, mark: "best" }, …] }].',
    ].join("\n"),
    parameters: Type.Object({
      card_id: Type.Optional(Type.String({ description: "To update a card: the id show_card returned for it. Omit to show a new card" })),
      kind: Type.Union(CARD_KIND_NAMES.map((n) => Type.Literal(n))),
      title: Type.String({
        description: `The matter's name, at most ${TITLE_MAX} characters, e.g. 'Shanghai ⇄ Tokyo, Oct 10'. A name, never a sentence or the state of things: status and buttons say those`,
      }),
      status: Type.Optional(Type.Union(STATUSES.map((s) => Type.Literal(s)))),
      data: Type.Record(Type.String(), Type.Unknown(), { description: "Shaped by the kind, as listed above" }),
      buttons: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String({ description: `At most ${LABEL_MAX} characters, e.g. 'Book both'` }),
            reply: Type.Optional(Type.String({ description: "Sent to this thread as the owner's message" })),
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
      const data = normalizeData(kind, args.data, ctx.app.settings.get().timezone);
      if ([...args.title].length > TITLE_MAX) throw new Error(`The title is too long (${[...args.title].length} characters, at most ${TITLE_MAX}). Name the matter in a few words.`);
      if (!Value.Check(kind.data, data)) {
        const problems = [...Value.Errors(kind.data, data)].slice(0, 5).map((e) => `${e.instancePath || "data"} ${e.message}`);
        throw new Error(`The data does not fit a ${kind.name} card: ${problems.join("; ")}. Expected ${shapeOf(kind.data)}.`);
      }
      if (kind.name === "card") checkBlocks(data.blocks as unknown[]);
      const long = (args.buttons ?? []).find((b) => [...b.label].length > LABEL_MAX);
      if (long) throw new Error(`The button "${long.label}" is too long (at most ${LABEL_MAX} characters). Label it in two or three words; details go in its reply.`);
      const buttons = (args.buttons ?? []).filter((b) => b.reply || (b.url && /^https?:\/\//.test(b.url)));
      const card = ctx.app.cards.save(ctx.thread.id, {
        id: args.card_id,
        kind: kind.name,
        title: args.title,
        status: (args.status ?? "ready") as CardStatus,
        data,
        buttons,
      });
      return { text: `Card ${card.id} is on the owner's home page. To change it later, call show_card with card_id "${card.id}".` };
    },
  }),
];
