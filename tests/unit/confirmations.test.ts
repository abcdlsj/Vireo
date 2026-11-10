import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../apps/node/src/app.js";
import { tempDir, testApp } from "./helpers.js";

let apps: App[] = [];
afterEach(async () => {
  for (const app of apps) {
    await app.runner.idle();
    await app.browser.shutdown();
    try {
      app.db.close();
    } catch {
      // already closed
    }
  }
  apps = [];
});

function open(dir?: string): App {
  const app = testApp(dir);
  apps.push(app);
  return app;
}

async function events(app: App) {
  return app.integrations.localCalendar.listEvents(new Date(0), new Date(8.64e15));
}

describe("confirmation gating", () => {
  it("pauses an outward action until the owner confirms, then resumes the thread", async () => {
    const app = open();
    const t = app.threads.create({});
    app.runner.send(t.id, "Schedule a 30 min meeting with anna@example.com tomorrow");
    await app.runner.idle();

    const [pending] = app.actions.pending();
    expect(pending).toMatchObject({ threadId: t.id, tool: "create_event", status: "pending" });
    expect(await events(app)).toHaveLength(0);

    const done = await app.actions.confirm(pending!.id);
    expect(done.status).toBe("done");
    await app.runner.idle();
    const created = await events(app);
    expect(created.map((e) => e.attendees)).toEqual([["anna@example.com"]]);
    const last = app.threads.messages(t.id).at(-1)!;
    expect(last.role).toBe("assistant");
  });

  it("never runs a cancelled action", async () => {
    const app = open();
    const t = app.threads.create({});
    app.runner.send(t.id, "Schedule a 30 min meeting with bob@example.com tomorrow");
    await app.runner.idle();
    const [pending] = app.actions.pending();
    app.actions.cancel(pending!.id);
    await app.runner.idle();
    // A late confirm (e.g. from a stale phone tab) does nothing.
    expect((await app.actions.confirm(pending!.id)).status).toBe("cancelled");
    expect(await events(app)).toHaveLength(0);
  });

  it("keeps pending confirmations across a restart", async () => {
    const dir = tempDir();
    const first = open(dir);
    const t = first.threads.create({});
    first.runner.send(t.id, "Schedule a 30 min meeting with carol@example.com tomorrow");
    await first.runner.idle();
    const [pending] = first.actions.pending();
    expect(pending).toBeTruthy();
    first.db.close();

    const second = open(dir);
    expect(second.actions.pending().map((a) => a.id)).toEqual([pending!.id]);
    await second.actions.confirm(pending!.id);
    await second.runner.idle();
    expect((await events(second)).some((e) => e.attendees.includes("carol@example.com"))).toBe(true);
  });

  it("asks one thing at a time: a newer confirmation retires the one still waiting", async () => {
    const app = open();
    const t = app.threads.create({});
    const first = app.actions.create(t.id, "create_event", { title: "A" }, "Create A");
    const second = app.actions.create(t.id, "create_event", { title: "B" }, "Create B");

    expect(app.actions.get(first.id)!.status).toBe("cancelled");
    expect(app.actions.get(second.id)!.status).toBe("pending");
    expect(app.actions.pending().filter((a) => a.threadId === t.id)).toHaveLength(1);
    // The retired one cannot be confirmed from a stale card.
    expect((await app.actions.confirm(first.id)).status).toBe("cancelled");
    expect(await events(app)).toHaveLength(0);
  });

  it("drops an open confirmation when the matter is closed, and the thread stops saying it waits", async () => {
    const app = open();
    const t = app.threads.create({ title: "Book a table" });
    const pending = app.actions.create(t.id, "create_event", { title: "A" }, "Create A");
    expect(app.threads.get(t.id)!.pendingActions).toBe(1);

    await app.lifecycle.complete(t.id);

    expect(app.actions.get(pending.id)!.status).toBe("cancelled");
    const closed = app.threads.get(t.id)!;
    expect(closed.pendingActions).toBe(0);
    expect(closed.statusLine).not.toMatch(/Waiting for your confirmation/);
    expect(closed.needsYou).toBe(false);

    // A restart leaves nothing waiting in a closed matter either.
    app.db.run("UPDATE actions SET status = 'pending' WHERE id = ?", pending.id);
    app.db.close();
    const again = open(app.config.dataDir);
    expect(again.actions.get(pending.id)!.status).toBe("cancelled");
  });
});
