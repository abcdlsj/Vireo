import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../apps/node/src/app.js";
import { createHttp } from "../../apps/node/src/http/index.js";
import { PATH } from "../../apps/node/src/plugins/endpoint/index.js";
import { testApp } from "./helpers.js";

let apps: App[] = [];
afterEach(async () => {
  for (const app of apps) {
    await app.runner.idle();
    await app.plugins.stop();
    await app.browser.shutdown();
    app.db.close();
  }
  apps = [];
});

const REQ = { origin: "http://localhost" };

async function setup() {
  const app = testApp();
  apps.push(app);
  await app.plugins.install("endpoint");
  const made = await app.plugins.action("endpoint", "new", REQ);
  const secret = /shown only this once: (\S+)/.exec(made.message ?? "")![1]!;
  const http = createHttp(app);
  const connect = async (key = secret) => {
    const client = new Client({ name: "test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://node${PATH}`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      fetch: (url, init) => Promise.resolve(http.request(String(url), init as RequestInit)),
    });
    await client.connect(transport);
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return (r.content as { text: string }[])[0]!.text;
  };
  return { app, http, secret, connect, call };
}

describe("Vireo over MCP", () => {
  it("answers only requests with a key made in Settings", async () => {
    const { app, http, secret, connect } = await setup();
    expect((await http.request(PATH, { method: "POST" })).status).toBe(401);
    expect((await http.request(PATH, { method: "POST", headers: { authorization: "Bearer vireo_wrong" } })).status).toBe(401);
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ask_vireo", "request_approval", "approval_status", "notify_owner", "search_memory", "read_thread"]));
    await client.close();
    // The key is kept only as a hash, and revoking shuts the door.
    expect(JSON.stringify(app.db.getKv("plugin.endpoint.keys"))).not.toContain(secret);
    await app.plugins.action("endpoint", "revoke", REQ);
    await expect(connect()).rejects.toThrow();
  });

  it("asks the owner to approve, and reports the decision without resuming a thread", async () => {
    const { app, connect, call } = await setup();
    const client = await connect();
    const first = await call(client, "request_approval", { summary: "Deploy api to production", details: "Rolls out v2", from: "Claude Code", wait_seconds: 0 });
    expect(first).toMatch(/^pending/);
    const id = /approval_id "([^"]+)"/.exec(first)![1]!;
    const action = app.actions.get(id)!;
    expect(action.summary).toBe("Deploy api to production");
    expect(app.push.recent[0]!.title).toContain("Confirm");

    await app.actions.confirm(id, { description: "Rolls out v2, canary first" });
    expect(await call(client, "approval_status", { approval_id: id })).toContain("canary first");
    expect(app.threads.get(action.threadId)!.running).toBe(false);
    expect(app.threads.messages(action.threadId).filter((m) => m.role === "assistant")).toHaveLength(0);

    const second = await call(client, "request_approval", { summary: "Drop the old table", wait_seconds: 0 });
    app.actions.cancel(/approval_id "([^"]+)"/.exec(second)![1]!);
    expect(await call(client, "approval_status", { approval_id: /approval_id "([^"]+)"/.exec(second)![1]! })).toMatch(/^declined/);
    await client.close();
  });

  it("asks Vireo in a thread of its own and tells the owner things", async () => {
    const { app, connect, call } = await setup();
    const client = await connect();
    const out = await call(client, "ask_vireo", { text: "What's on my calendar today?", from: "a script", wait_seconds: 60 });
    const threadId = /thread_id: (\S+)/.exec(out)![1]!;
    const asked = app.threads.messages(threadId).find((m) => m.role === "user")!;
    expect(JSON.stringify(asked.body)).toContain("From a script (Key 1)");
    expect(await call(client, "read_thread", { thread_id: threadId })).toContain("calendar");

    await call(client, "notify_owner", { title: "Backup finished", body: "42 GB", from: "nas" });
    expect(app.push.recent[0]).toMatchObject({ title: "Backup finished · nas (Key 1)", body: "42 GB" });
    await client.close();
  });
});

describe("Vireo over MCP keys", () => {
  it("does not let an ordinary key decide confirmations", async () => {
    const { app, connect, call } = await setup();
    const client = await connect();
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("decide_action");
    const t = app.threads.create({ temporary: true });
    const a = app.actions.create(t.id, "agent_approval", { from: "x" }, "Deploy");
    expect(await call(client, "decide_action", { action_id: a.id, decision: "confirm" })).toContain("can decide");
    expect(app.actions.get(a.id)!.status).toBe("pending");
    await client.close();
  });
});

describe("one-tap decisions on a notification", () => {
  it("confirm or decline a pending action with a link signed for it", async () => {
    const app = testApp();
    apps.push(app);
    const http = createHttp(app);
    const t = app.threads.create({ temporary: true });
    const a = app.actions.create(t.id, "agent_approval", { from: "x" }, "Deploy");
    const { decide } = app.push.recent[0]!;
    expect(decide?.confirm).toContain(`/public/decide/${a.id}/confirm?sig=`);
    const path = (u: string) => u.replace(/^https?:\/\/[^/]+/, "");
    // A link for one answer does not work for the other, nor for another action.
    expect((await http.request(path(decide!.confirm).replace("/confirm?", "/cancel?"), { method: "POST" })).status).toBe(403);
    const b = app.actions.create(t.id, "agent_approval", { from: "x" }, "Delete");
    expect((await http.request(path(decide!.confirm).replace(a.id, b.id), { method: "POST" })).status).toBe(403);
    expect(await (await http.request(path(decide!.confirm), { method: "POST" })).json()).toMatchObject({ status: "done" });
    expect(app.actions.get(a.id)!.status).toBe("done");
    const declined = await http.request(path(app.push.recent[0]!.decide!.cancel), { method: "POST" });
    expect(await declined.json()).toMatchObject({ status: "cancelled" });
  });
});
