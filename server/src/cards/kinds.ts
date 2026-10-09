import { Type, type TSchema } from "typebox";

/**
 * Card kinds the agent can show. A few matters that recur and have a shape
 * of their own (a flight, a trip, an event, an email, a pull request,
 * something watched, a place, a document) get a kind with a designed card;
 * everything else is the general "card", composed from blocks (blocks.ts).
 * A kind is a name, a sentence telling the model when to use it, and the
 * shape of its data; the web app has one component per kind
 * (web/src/cards/kinds/<name>.tsx). Cards of kinds that were retired keep
 * rendering with their old components.
 *
 * Cards are glanced at, not read, so every text field has a length limit and
 * every list a size limit. Data over a limit is refused and the model has to
 * say it shorter; the full story belongs in the chat or a document card.
 */
export interface CardKind {
  name: string;
  /** Tells the model when to pick this kind. */
  description: string;
  data: TSchema;
  /** Data fields holding a moment in time. Vireo turns what the model wrote into ISO 8601 with offset. */
  times?: string[];
}

/** Text of at most `max` characters. */
const Str = (max: number, description?: string) => Type.String({ maxLength: max, ...(description ? { description } : {}) });
const Opt = <T extends TSchema>(t: T) => Type.Optional(t);
const List = <T extends TSchema>(t: T, max: number, description?: string) => Type.Array(t, { maxItems: max, ...(description ? { description } : {}) });
const Url = Type.String({ maxLength: 2000 });
/** A short number that decides, e.g. a price: "¥804", "320 USD". */
const Value = (description = "The number that decides, e.g. a price") => Str(16, description);
const Leg = Type.Object({
  from: Str(4, "Airport code, e.g. PVG"),
  to: Str(4, "Airport code, e.g. NRT"),
  departs: Str(5, "Local time, e.g. 17:35"),
  arrives: Str(12, "Local time, e.g. 21:35 or 00:50 +1"),
  date: Str(10, "e.g. 2026-10-10"),
  airline: Opt(Str(24)),
  flight: Opt(Str(12, "e.g. IJ 004")),
  price: Opt(Value()),
});

export const CARD_KINDS: CardKind[] = [
  {
    name: "card",
    description:
      "The general card, for anything without a kind of its own: an answer, options to compare, a batch handled, a person, a file, a page. Compose it from blocks (listed below), the most important first.",
    data: Type.Object({
      subtitle: Opt(Str(60, "One line under the title, e.g. the criteria or the source")),
      blocks: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 4, description: "1 to 4 blocks" }),
    }),
  },
  {
    name: "watch",
    description: "Something Vireo keeps an eye on that changes over time: a price, a delivery, a page, a queue.",
    data: Type.Object({
      value: Str(20, "The current value, e.g. '320 USD' or 'Out for delivery'"),
      detail: Opt(Str(80)),
      trend: Opt(List(Type.Number(), 30, "Recent values, oldest first, for a small chart")),
      steps: Opt(List(Str(20), 5, "Stages in order, a word or two each, e.g. Shipped, Sorted, Out for delivery, Delivered")),
      current: Opt(Type.Number({ description: "Index into steps of the current stage" })),
      checked_at: Opt(Str(40, "When you last checked, e.g. 2026-10-09T19:40+08:00")),
    }),
    times: ["checked_at"],
  },
  {
    name: "document",
    description: "Something Vireo wrote or assembled for the owner to keep: an itinerary, a plan, notes, a draft.",
    data: Type.Object({
      text: Str(8000, "Markdown"),
      file_id: Opt(Str(60, "A file created with create_file")),
    }),
  },
  {
    name: "flight",
    description: "One flight, either the best option found or a booked ticket. For a round trip use trip.",
    data: Type.Object({
      from: Str(4, "Airport code, e.g. PVG"),
      to: Str(4, "Airport code, e.g. HND"),
      departs: Str(5, "Local time, e.g. 08:10"),
      arrives: Str(12, "Local time, e.g. 12:05"),
      date: Str(10, "e.g. 2026-11-14"),
      airline: Opt(Str(24)),
      flight: Opt(Str(12, "e.g. NH 920")),
      duration: Opt(Str(12)),
      details: Opt(List(Str(20), 3, "e.g. Aisle seat, 1 checked bag")),
      price: Opt(Value()),
      trend: Opt(List(Type.Number(), 30)),
      booked: Opt(Type.Object({ seat: Opt(Str(6)), ref: Opt(Str(12)) })),
    }),
  },
  {
    name: "trip",
    description:
      "Flights there and back, on one ticket or two one-ways: the outbound flight (picked or best found), the return once picked, and while it isn't, the cheapest return per date to choose from. Use it for any two-leg trip, from searching to booked.",
    data: Type.Object({
      outbound: Leg,
      return: Opt(Leg),
      total: Opt(Value("Both legs together, e.g. ¥3,006")),
      return_options: Opt(
        List(
          Type.Object({
            date: Str(10, "e.g. 2026-10-19"),
            price: Value("Cheapest return that day"),
            flight: Opt(Str(40, "That flight in brief, e.g. 'NRT 22:25 → PVG 00:50 +1'")),
          }),
          10,
          "In date order",
        ),
      ),
      note: Opt(Str(100, "One caveat, e.g. 'Fares exclude checked bags'")),
    }),
  },
  {
    name: "event",
    description: "A calendar event that is already on the owner's calendar or worth showing (not a pending invite: those confirm themselves).",
    data: Type.Object({
      start: Str(40, "Date and time, e.g. 2026-10-14T15:30+08:00"),
      end: Opt(Str(40, "Date and time, e.g. 2026-10-14T16:15+08:00")),
      location: Opt(Str(60)),
      attendees: Opt(List(Str(80), 20)),
      note: Opt(Str(120)),
    }),
    times: ["start", "end"],
  },
  {
    name: "email",
    description: "One email worth the owner's attention, with Vireo's draft reply if there is one.",
    data: Type.Object({
      from: Str(60),
      address: Opt(Str(120)),
      subject: Str(100),
      received: Opt(Str(40, "e.g. 2026-10-09T09:12+08:00")),
      body: Str(600, "The relevant part of the message"),
      draft: Opt(Str(1200, "Vireo's suggested reply")),
    }),
    times: ["received"],
  },
  {
    name: "github_pr",
    description: "A GitHub pull request: its checks, review state and size.",
    data: Type.Object({
      repo: Str(100, "owner/name"),
      number: Type.Number(),
      url: Opt(Url),
      state: Opt(Type.Union([Type.Literal("open"), Type.Literal("draft"), Type.Literal("merged"), Type.Literal("closed")])),
      additions: Opt(Type.Number()),
      deletions: Opt(Type.Number()),
      files: Opt(Type.Number()),
      checks: Opt(Type.Object({ passed: Type.Number(), total: Type.Number() })),
      review: Opt(Str(60, "e.g. 'Approved by 1 reviewer'")),
    }),
  },
  {
    name: "place",
    description: "A place: a restaurant, shop, venue or address, possibly with a time.",
    data: Type.Object({
      name: Str(40),
      address: Opt(Str(80)),
      distance: Opt(Str(12)),
      when: Opt(Str(40)),
      note: Opt(Str(100)),
      url: Opt(Url),
    }),
  },
];

export const CARD_KIND_NAMES = CARD_KINDS.map((k) => k.name);

export function cardKind(name: string): CardKind | undefined {
  return CARD_KINDS.find((k) => k.name === name);
}
