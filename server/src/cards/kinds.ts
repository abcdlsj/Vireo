import { Type, type TSchema } from "typebox";

/**
 * Card kinds the agent can show. A kind is a name, a sentence telling the
 * model when to use it, and the shape of its data; the web app has one
 * component per kind (web/src/cards/kinds/<name>.tsx). Adding a kind means
 * adding an entry here and that component, nothing else.
 */
export interface CardKind {
  name: string;
  /** Tells the model when to pick this kind. */
  description: string;
  data: TSchema;
}

const Str = (description?: string) => Type.String(description ? { description } : {});
const Opt = <T extends TSchema>(t: T) => Type.Optional(t);
const Link = Type.Object({ title: Str(), url: Str() });
const Field = Type.Object({ label: Str(), value: Str() });

export const CARD_KINDS: CardKind[] = [
  {
    name: "answer",
    description: "A direct answer to a question: the conclusion first, with sources. The fallback when nothing else fits.",
    data: Type.Object({
      text: Str("The answer in markdown; lead with the conclusion"),
      sources: Opt(Type.Array(Link)),
    }),
  },
  {
    name: "compare",
    description: "Several options side by side to choose from: hotels, products, plans, restaurants.",
    data: Type.Object({
      subtitle: Opt(Str("The criteria used, e.g. 'Direct, under 300 USD'")),
      options: Type.Array(
        Type.Object({
          title: Str(),
          subtitle: Opt(Str()),
          value: Opt(Str("The number that decides, e.g. a price")),
          badge: Opt(Str("e.g. 'My pick'")),
          url: Opt(Str()),
        }),
      ),
      note: Opt(Str()),
    }),
  },
  {
    name: "summary",
    description: "The outcome of handling a batch of things: an inbox tidied, files sorted, a list processed.",
    data: Type.Object({
      subtitle: Opt(Str()),
      stats: Opt(Type.Array(Type.Object({ label: Str(), value: Str(), attention: Opt(Type.Boolean()) }))),
      items: Opt(Type.Array(Type.Object({ title: Str(), text: Opt(Str()), url: Opt(Str()) }))),
    }),
  },
  {
    name: "watch",
    description: "Something Vireo keeps an eye on that changes over time: a price, a delivery, a page, a queue.",
    data: Type.Object({
      value: Str("The current value, e.g. '320 USD' or 'Out for delivery'"),
      detail: Opt(Str()),
      trend: Opt(Type.Array(Type.Number(), { description: "Recent values, oldest first, for a small chart" })),
      steps: Opt(Type.Array(Str(), { description: "Stages in order, e.g. Shipped, Sorted, Out for delivery, Delivered" })),
      current: Opt(Type.Number({ description: "Index into steps of the current stage" })),
      checked_at: Opt(Str("ISO time of the last check")),
    }),
  },
  {
    name: "document",
    description: "Something Vireo wrote or assembled for the owner to keep: an itinerary, a plan, notes, a draft.",
    data: Type.Object({
      text: Str("Markdown"),
      file_id: Opt(Str("A file created with create_file")),
    }),
  },
  {
    name: "flight",
    description: "One flight, either the best option found or a booked ticket.",
    data: Type.Object({
      from: Str("Airport code, e.g. PVG"),
      to: Str("Airport code, e.g. HND"),
      departs: Str("Local time, e.g. 08:10"),
      arrives: Str("Local time, e.g. 12:05"),
      date: Str("e.g. 2026-11-14"),
      airline: Opt(Str()),
      flight: Opt(Str("e.g. NH 920")),
      duration: Opt(Str()),
      details: Opt(Type.Array(Str(), { description: "e.g. Aisle seat, 1 checked bag" })),
      price: Opt(Str()),
      trend: Opt(Type.Array(Type.Number())),
      booked: Opt(Type.Object({ seat: Opt(Str()), ref: Opt(Str()) })),
    }),
  },
  {
    name: "event",
    description: "A calendar event that is already on the owner's calendar or worth showing (not a pending invite: those confirm themselves).",
    data: Type.Object({
      start: Str("ISO 8601 with offset"),
      end: Opt(Str("ISO 8601 with offset")),
      location: Opt(Str()),
      attendees: Opt(Type.Array(Str())),
      note: Opt(Str()),
    }),
  },
  {
    name: "email",
    description: "One email worth the owner's attention, with Vireo's draft reply if there is one.",
    data: Type.Object({
      from: Str(),
      address: Opt(Str()),
      subject: Str(),
      received: Opt(Str("ISO time")),
      body: Str("The relevant part of the message"),
      draft: Opt(Str("Vireo's suggested reply")),
    }),
  },
  {
    name: "github_pr",
    description: "A GitHub pull request: its checks, review state and size.",
    data: Type.Object({
      repo: Str("owner/name"),
      number: Type.Number(),
      url: Opt(Str()),
      state: Opt(Type.Union([Type.Literal("open"), Type.Literal("draft"), Type.Literal("merged"), Type.Literal("closed")])),
      additions: Opt(Type.Number()),
      deletions: Opt(Type.Number()),
      files: Opt(Type.Number()),
      checks: Opt(Type.Object({ passed: Type.Number(), total: Type.Number() })),
      review: Opt(Str("e.g. 'Approved by 1 reviewer'")),
    }),
  },
  {
    name: "github_repo",
    description: "Activity in a GitHub repository the owner follows.",
    data: Type.Object({
      repo: Str("owner/name"),
      url: Opt(Str()),
      activity: Opt(Type.Array(Type.Number(), { description: "Commits per day, oldest first" })),
      stats: Opt(Type.Array(Field)),
      latest: Opt(Str("The newest notable event")),
    }),
  },
  {
    name: "web_page",
    description: "A web page worth keeping, with what matters on it.",
    data: Type.Object({
      url: Str(),
      summary: Str(),
      site: Opt(Str()),
    }),
  },
  {
    name: "place",
    description: "A place: a restaurant, shop, venue or address, possibly with a time.",
    data: Type.Object({
      name: Str(),
      address: Opt(Str()),
      distance: Opt(Str()),
      when: Opt(Str()),
      note: Opt(Str()),
      url: Opt(Str()),
    }),
  },
  {
    name: "person",
    description: "Someone the owner deals with, and what Vireo knows about them.",
    data: Type.Object({
      name: Str(),
      role: Opt(Str()),
      email: Opt(Str()),
      facts: Opt(Type.Array(Str())),
    }),
  },
  {
    name: "file",
    description: "A file and the key facts in it: a contract, an invoice, a statement.",
    data: Type.Object({
      name: Str(),
      file_id: Opt(Str()),
      meta: Opt(Str("e.g. '12 pages · from Lin'")),
      fields: Opt(Type.Array(Field)),
    }),
  },
];

export const CARD_KIND_NAMES = CARD_KINDS.map((k) => k.name);

export function cardKind(name: string): CardKind | undefined {
  return CARD_KINDS.find((k) => k.name === name);
}
