import { describe, expect, it } from "vitest";
import { threadRoutes } from "../../apps/node/src/http/threads.js";
import { OVERVIEW_ID } from "../../apps/node/src/threads.js";
import { testApp } from "./helpers.js";

describe("archiving a thread", () => {
  it("takes it out of the lists and keeps everything it holds", async () => {
    const app = testApp();
    const t = app.threads.create({ title: "Renew the passport" });
    app.threads.addNotice(t.id, "info", "note");
    app.files.save({ threadId: t.id, name: "form.txt", mime: "text/plain", data: Buffer.from("x"), origin: "upload" });

    await app.lifecycle.archive(t.id);

    expect(app.threads.list().map((x) => x.id)).not.toContain(t.id);
    expect(app.threads.listArchived().map((x) => x.id)).toContain(t.id);
    const kept = app.threads.get(t.id)!;
    expect(kept.group).toBe("archived");
    expect(kept.archivedAt).toBeGreaterThan(0);
    expect(kept.needsYou).toBe(false);
    expect(app.threads.messages(t.id).length).toBeGreaterThan(0);
    expect(app.files.forThread(t.id)).toHaveLength(1);
    app.db.close();
  });

  it("comes back when the owner writes in it", async () => {
    const app = testApp();
    const t = app.threads.create({ title: "Book the ferry" });
    await app.lifecycle.archive(t.id);
    await app.runner.settled(t.id);
    app.threads.unarchive(t.id);
    expect(app.threads.get(t.id)!.group).not.toBe("archived");
    expect(app.threads.list().map((x) => x.id)).toContain(t.id);
    app.db.close();
  });

  it("refuses the Overview thread", async () => {
    const app = testApp();
    await expect(app.lifecycle.archive(OVERVIEW_ID)).rejects.toThrow(/Overview/);
    app.db.close();
  });

  it("answers over HTTP and lists archived threads alongside the rest", async () => {
    const app = testApp();
    const r = threadRoutes(app);
    const t = app.threads.create({ title: "Old matter" });

    const res = await r.request(`/threads/${t.id}/archive`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { thread: { group: string } }).thread.group).toBe("archived");

    const list = (await (await r.request("/threads")).json()) as { threads: { id: string; group: string }[] };
    expect(list.threads.find((x) => x.id === t.id)?.group).toBe("archived");

    await r.request(`/threads/${t.id}/unarchive`, { method: "POST" });
    const after = (await (await r.request("/threads")).json()) as { threads: { id: string; group: string }[] };
    expect(after.threads.find((x) => x.id === t.id)?.group).not.toBe("archived");
    app.db.close();
  });
});
