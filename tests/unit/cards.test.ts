import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../server/src/app.js";
import { CARD_KINDS } from "../../server/src/cards/kinds.js";
import { OVERVIEW_ID } from "../../server/src/threads.js";
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
    expect(shapeOf(CARD_KINDS.find((k) => k.name === "answer")!.data)).toBe("{ text, sources?: [{ title, url }] }");
  });

  it("checks the data against the kind and updates a card in place", async () => {
    const a = open();
    const t = a.threads.create({ title: "Tokyo flights" });
    await expect(show(a, t.id, { kind: "flight", title: "PVG to HND", data: { from: "PVG" } })).rejects.toThrow(/does not fit a flight card/);
    await expect(show(a, t.id, { kind: "hologram", title: "x", data: {} })).rejects.toThrow(/Unknown kind/);

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

    await show(a, t.id, {
      card_id: id,
      kind: "flight",
      title: "PVG to HND",
      status: "done",
      data: { from: "PVG", to: "HND", departs: "08:10", arrives: "12:05", date: "2026-11-14", booked: { seat: "14C", ref: "K7Q2XD" } },
    });
    expect(a.cards.forThread(t.id)).toHaveLength(1);
    expect(a.cards.get(id)!.data.booked).toEqual({ seat: "14C", ref: "K7Q2XD" });

    // A card id from another thread can't be reached.
    const other = a.threads.create({});
    await expect(show(a, other.id, { card_id: id, kind: "answer", title: "x", data: { text: "x" } })).rejects.toThrow(/No card/);
    // Overview answers in place; cards belong to a matter.
    await expect(show(a, OVERVIEW_ID, { kind: "answer", title: "x", data: { text: "x" } })).rejects.toThrow(/open_thread/);
  });

  it("feeds the home board: pending confirmations first, every matter once, temporary threads left out", async () => {
    const a = open();
    const withCard = a.threads.create({ title: "Inbox" });
    await show(a, withCard.id, { kind: "summary", title: "Inbox sorted", data: { stats: [{ label: "archived", value: "42" }] } });
    const plain = a.threads.create({ title: "A question" });
    a.threads.create({ title: "Secret", temporary: true });

    const meeting = a.threads.create({});
    a.runner.send(meeting.id, "Schedule a 30 min meeting with anna@example.com tomorrow");
    await a.runner.idle();

    const feed = a.cards.feed();
    expect(feed[0]).toMatchObject({ kind: "proposal", status: "needs_you", threadId: meeting.id });
    expect(feed[0]!.data).toMatchObject({ tool: "create_event" });
    expect(feed.filter((c) => c.threadId === meeting.id)).toHaveLength(1);
    expect(feed.find((c) => c.threadId === withCard.id)).toMatchObject({ kind: "summary", title: "Inbox sorted" });
    expect(feed.find((c) => c.threadId === plain.id)).toMatchObject({ kind: "thread", id: `thread:${plain.id}` });
    expect(feed.some((c) => c.threadTitle === "Secret")).toBe(false);
    expect(feed.some((c) => c.threadId === OVERVIEW_ID)).toBe(false);
  });
});
