import { Type, type TSchema } from "typebox";

/**
 * Card kinds the agent can show. A kind is a name, a sentence telling the
 * model when to use it, and the shape of its data; the web app has one
 * component per kind (web/src/cards/kinds/<name>.tsx). Adding a kind means
 * adding an entry here and that component, nothing else.
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
const Link = Type.Object({ title: Str(80), url: Url });
const Field = Type.Object({ label: Str(24), value: Str(40) });
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
    name: "answer",
    description: "A direct answer to a question: the conclusion first, with sources. The fallback when nothing else fits.",
    data: Type.Object({
      text: Str(600, "Markdown. The first paragraph is the conclusion in one sentence; at most one short paragraph after it"),
      sources: Opt(List(Link, 5)),
    }),
  },
  {
    name: "compare",
    description: "A few options side by side to choose from: hotels, products, plans, restaurants. Put the best first and mark it with a badge.",
    data: Type.Object({
      subtitle: Opt(Str(60, "The criteria used, e.g. 'Direct, under 300 USD'")),
      options: List(
        Type.Object({
          title: Str(40, "The option's name only, no price"),
          subtitle: Opt(Str(60, "One fact that tells it apart")),
          value: Opt(Value()),
          badge: Opt(Str(12, "e.g. 'Cheapest'")),
          url: Opt(Url),
        }),
        5,
      ),
      note: Opt(Str(140, "One caveat worth knowing")),
    }),
  },
  {
    name: "summary",
    description: "The outcome of handling a batch of similar things: an inbox tidied, files sorted, a list processed. Never for flights, a place or a single matter.",
    data: Type.Object({
      subtitle: Opt(Str(60)),
      stats: Opt(List(Type.Object({ label: Str(16), value: Str(10), attention: Opt(Type.Boolean()) }), 4)),
      items: Opt(List(Type.Object({ title: Str(40), text: Opt(Str(60, "One fact, not a sentence of reasoning")), url: Opt(Url) }), 8)),
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
    name: "github_repo",
    description: "Activity in a GitHub repository the owner follows.",
    data: Type.Object({
      repo: Str(100, "owner/name"),
      url: Opt(Url),
      activity: Opt(List(Type.Number(), 28, "Commits per day, oldest first")),
      stats: Opt(List(Field, 3)),
      latest: Opt(Str(100, "The newest notable event")),
    }),
  },
  {
    name: "web_page",
    description: "A web page worth keeping, with what matters on it.",
    data: Type.Object({
      url: Url,
      summary: Str(240),
      site: Opt(Str(40)),
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
  {
    name: "person",
    description: "Someone the owner deals with, and what Vireo knows about them.",
    data: Type.Object({
      name: Str(40),
      role: Opt(Str(60)),
      email: Opt(Str(120)),
      facts: Opt(List(Str(60), 6)),
    }),
  },
  {
    name: "file",
    description: "A file and the key facts in it: a contract, an invoice, a statement.",
    data: Type.Object({
      name: Str(80),
      file_id: Opt(Str(60)),
      meta: Opt(Str(40, "e.g. '12 pages · from Lin'")),
      fields: Opt(List(Field, 6)),
    }),
  },
];

export const CARD_KIND_NAMES = CARD_KINDS.map((k) => k.name);

export function cardKind(name: string): CardKind | undefined {
  return CARD_KINDS.find((k) => k.name === name);
}
