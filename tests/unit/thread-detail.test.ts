import type { ThreadDetail } from "@vireo/protocol";
import { describe, expect, it } from "vitest";
import { threadRoutes } from "../../apps/node/src/http/threads.js";
import { testApp } from "./helpers.js";

describe("thread detail", () => {
  it("sends only the end of a conversation whose older part the app already has, and all of it once that part changed", async () => {
    const app = testApp();
    const r = threadRoutes(app);
    const t = app.threads.create({ title: "Long" });
    for (let i = 0; i < 30; i++) app.threads.addNotice(t.id, i === 3 ? "browser_request" : "info", `note ${i}`, { data: { n: String(i), state: "waiting" } });
    const get = async (q = "") => (await (await r.request(`/threads/${t.id}${q}`)).json()) as ThreadDetail;

    const full = await get();
    expect(full.from).toBe(0);
    expect(full.messages).toHaveLength(30);
    const p = full.prefix!;
    expect(p.count).toBe(30 - 12);

    app.threads.addNotice(t.id, "info", "note 30");
    const part = await get(`?from=${p.count}&sig=${p.sig}`);
    expect(part.from).toBe(p.count);
    expect([...full.messages.slice(0, part.from!), ...part.messages]).toEqual((await get()).messages);

    // An older message changed: the prefix no longer matches, so everything comes.
    app.threads.updateNotice(t.id, "browser_request", { name: "n", value: "3" }, { state: "done" });
    const again = await get(`?from=${p.count}&sig=${p.sig}`);
    expect(again.from).toBe(0);
    expect(again.messages).toHaveLength(31);
    expect(await get(`?from=999&sig=x`)).toMatchObject({ from: 0 });
    app.db.close();
  });
});
