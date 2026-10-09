import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../server/src/app.js";
import { BLOCK_KINDS } from "../../server/src/cards/blocks.js";
import { CARD_KINDS } from "../../server/src/cards/kinds.js";
import { OVERVIEW_ID } from "../../server/src/threads.js";
import { toZonedIso, zonedToUtc } from "../../server/src/time.js";
import { shapeOf } from "../../server/src/tools/cards.js";
import { testApp } from "./helpers.js";

let apps: App[] = [];
afterEach(async () => {
  for (const app of apps) {
    await app.runner.idle();
    await app.browser.shutdown();
    app.db.close();
  }
  apps = [];
});

function open(): App {
  const app = testApp();
  apps.push(app);
  return app;
}

function show(app: App, threadId: string, args: Record<string, unknown>) {
  const thread = app.threads.get(threadId)!;
  return app.tools.get("show_card")!.run(args as never, { app, thread, agent: "general" });
}

describe("cards", () => {
  it("describes every kind's data to the model", () => {
    const description = open().tools.get("show_card")!.description;
    for (const k of CARD_KINDS) expect(description).toContain(`- ${k.name}:`);
    expect(shapeOf(CARD_KINDS.find((k) => k.name === "github_pr")!.data)).toContain('state?: "open"|"draft"|"merged"|"closed"');
    // The general card's blocks are described too.
    for (const b of BLOCK_KINDS) expect(description).toContain(`- ${b.type}:`);
    // Field hints reach the model, and a shape used twice is spelled out once.
    expect(description).toContain('start: ≤40 "Date and time, e.g. 2026-10-14T15:30+08:00"');
    expect(description).toContain("return?: same as outbound");
  });

  it("checks the data against the kind and updates a card in place", async () => {
    const a = open();
    const t = a.threads.create({ title: "Tokyo flights" });
    await expect(show(a, t.id, { kind: "flight", title: "PVG to HND", data: { from: "PVG" } })).rejects.toThrow(/does not fit a flight card/);
    await expect(show(a, t.id, { kind: "hologram", title: "x", data: {} })).rejects.toThrow(/Unknown kind/);
    // Cards stay glanceable: long titles and fields are refused, so the model says it shorter.
    await expect(show(a, t.id, { kind: "card", title: "x".repeat(41), data: { blocks: [{ type: "text", text: "x" }] } })).rejects.toThrow(/title is too long/);
    await expect(
      show(a, t.id, { kind: "card", title: "x", data: { blocks: [{ type: "text", text: "x" }] }, buttons: [{ label: "Book both legs with carry-on only", reply: "Book both" }] }),
    ).rejects.toThrow(/button .* is too long/);
    // The general card checks each block against its own type.
    await expect(
      show(a, t.id, { kind: "card", title: "Hotels", data: { blocks: [{ type: "rows", items: [{ title: "A hotel with a very long name that also lists its price, ¥804" }] }] } }),
    ).rejects.toThrow(/blocks\/0\/items\/0\/title/);
    await expect(show(a, t.id, { kind: "card", title: "x", data: { blocks: [{ type: "hologram" }] } })).rejects.toThrow(/unknown type/);

    const out = await show(a, t.id, {
      kind: "flight",
      title: "PVG to HND",
      status: "watching",
      data: { from: "PVG", to: "HND", departs: "08:10", arrives: "12:05", date: "2026-11-14", price: "320 USD" },
      buttons: [{ label: "Book this", reply: "Book it" }, { label: "Bad", url: "javascript:alert(1)" }],
    });
    const id = out.text.match(/Card (\S+)/)![1]!;
    const card = a.cards.get(id)!;
    expect(card).toMatchObject({ kind: "flight", status: "watching", threadTitle: "Tokyo flights" });
    expect(card.buttons).toEqual([{ label: "Book this", reply: "Book it" }]);
    expect(card.changes).toEqual([]);

    // An update remembers the few facts it changed, for the card to say so.
    await show(a, t.id, {
      card_id: id,
      kind: "flight",
      title: "PVG to HND",
      status: "watching",
      data: { from: "PVG", to: "HND", departs: "08:10", arrives: "12:05", date: "2026-11-14", price: "298 USD" },
    });
    expect(a.cards.get(id)!.changes).toEqual([{ label: "Price", from: "320 USD", to: "298 USD" }]);

    await show(a, t.id, {
      card_id: id,
      kind: "flight",
      title: "PVG to HND",
      status: "done",
      data: { from: "PVG", to: "HND", departs: "08:10", arrives: "12:05", date: "2026-11-14", booked: { seat: "14C", ref: "K7Q2XD" } },
    });
    expect(a.cards.forThread(t.id)).toHaveLength(1);
    expect(a.cards.get(id)!.data.booked).toEqual({ seat: "14C", ref: "K7Q2XD" });

    // A card id from another thread can't be reached: the call shows a card in its own thread.
    const other = a.threads.create({});
    await show(a, other.id, { card_id: id, kind: "card", title: "x", data: { blocks: [{ type: "text", text: "x" }] } });
    expect(a.cards.get(id)!.kind).toBe("flight");
    expect(a.cards.forThread(other.id)).toMatchObject([{ kind: "card" }]);
    // A made-up id updates the thread's latest card rather than failing the turn.
    await show(a, other.id, { card_id: "made-up", kind: "card", title: "y", data: { blocks: [{ type: "text", text: "y" }] } });
    expect(a.cards.forThread(other.id)).toMatchObject([{ title: "y" }]);
    // Overview answers in place; cards belong to a matter.
    await expect(show(a, OVERVIEW_ID, { kind: "card", title: "x", data: { blocks: [{ type: "text", text: "x" }] } })).rejects.toThrow(/open_thread/);
  });

  it("forgives the form models commonly get wrong", async () => {
    const a = open();
    const t = a.threads.create({ title: "Dentist" });
    const out = await show(a, t.id, {
      kind: "event",
      title: "Dentist",
      // Data as a JSON string, a time without an offset, an end of just a time.
      data: JSON.stringify({ start: "2026-10-14 15:30", end: "16:15", location: "Nanjing Road" }),
    });
    const card = a.cards.get(out.text.match(/Card (\S+)/)![1]!)!;
    const tz = a.settings.get().timezone;
    expect(card.data.start).toBe(toZonedIso(zonedToUtc(2026, 10, 14, 15, 30, tz), tz));
    expect(card.data.end).toBe(toZonedIso(zonedToUtc(2026, 10, 14, 16, 15, tz), tz));

    await show(a, t.id, { kind: "event", title: "Dentist", data: { start: "2026-10-14 15:30 +0800", end: "16:15" } });
    expect(a.cards.forThread(t.id).at(-1)!.data).toMatchObject({ start: "2026-10-14T15:30:00+08:00", end: "2026-10-14T16:15:00+08:00" });

    // Numbers where text is expected become text.
    await show(a, t.id, { kind: "card", title: "Hotels", data: { blocks: [{ type: "rows", items: [{ title: "Park Hotel", value: 804 }] }] } });
    expect(a.cards.forThread(t.id).at(-1)!.data).toEqual({ blocks: [{ type: "rows", items: [{ title: "Park Hotel", value: "804" }] }] });
  });

  it("feeds the home board: pending confirmations first, every matter once, temporary threads left out", async () => {
    const a = open();
    const withCard = a.threads.create({ title: "Inbox" });
    await show(a, withCard.id, { kind: "card", title: "Inbox sorted", data: { blocks: [{ type: "facts", items: [{ label: "Archived", value: "42" }] }] } });
    const plain = a.threads.create({ title: "A question" });
    a.threads.create({ title: "Secret", temporary: true });

    const meeting = a.threads.create({});
    a.runner.send(meeting.id, "Schedule a 30 min meeting with anna@example.com tomorrow");
    await a.runner.idle();

    const feed = a.cards.feed();
    expect(feed[0]).toMatchObject({ kind: "proposal", status: "needs_you", threadId: meeting.id });
    expect(feed[0]!.data).toMatchObject({ tool: "create_event" });
    expect(feed.filter((c) => c.threadId === meeting.id)).toHaveLength(1);
    expect(feed.find((c) => c.threadId === withCard.id)).toMatchObject({ kind: "card", title: "Inbox sorted" });
    expect(feed.find((c) => c.threadId === plain.id)).toMatchObject({ kind: "thread", id: `thread:${plain.id}` });
    expect(feed.some((c) => c.threadTitle === "Secret")).toBe(false);
    expect(feed.some((c) => c.threadId === OVERVIEW_ID)).toBe(false);
  });
});
