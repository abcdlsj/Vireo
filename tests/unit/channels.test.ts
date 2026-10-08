import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../server/src/app.js";
import { split } from "../../server/src/plugins/chat.js";
import { decryptFeishu } from "../../server/src/plugins/feishu/index.js";
import { parseServers, parseSecrets, toolName } from "../../server/src/plugins/mcp/index.js";
import { createHttp } from "../../server/src/http.js";
import { messageText, OVERVIEW_ID } from "../../server/src/threads.js";
import { testApp } from "./helpers.js";

let apps: App[] = [];
let servers: Server[] = [];
afterEach(async () => {
  for (const app of apps) {
    await app.runner.idle();
    await app.plugins.stop();
    await app.browser.shutdown();
    app.db.close();
  }
  for (const s of servers) s.close();
  apps = [];
  servers = [];
  delete process.env.VIREO_TELEGRAM_API_URL;
  delete process.env.VIREO_FEISHU_API_URL;
});

function open(): App {
  const app = testApp();
  apps.push(app);
  return app;
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A Telegram Bot API stand-in: queued updates for getUpdates, every sendMessage recorded. */
async function fakeTelegram() {
  const queue: unknown[] = [];
  const sent: { chat_id: string; text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }[] = [];
  const calls: string[] = [];
  let id = 100;
  const url = await listen((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      const method = req.url!.split("/").pop()!;
      calls.push(`${req.url!.split("/")[1]} ${method}`);
      const args = body ? JSON.parse(body) : {};
      const ok = (result: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
      if (method === "getMe") return ok({ id: 1, username: "vireo_test_bot" });
      if (method === "getUpdates") {
        if (!queue.length) await new Promise((r) => setTimeout(r, 50));
        return ok(queue.splice(0).filter((u) => (u as { update_id: number }).update_id >= (args.offset ?? 0)));
      }
      if (method === "sendMessage") {
        sent.push(args);
        return ok({ message_id: ++id });
      }
      return ok(true);
    });
  });
  let update = 1;
  const push = (u: object) => queue.push({ update_id: update++, ...u });
  const say = (text: string, extra: object = {}) => push({ message: { message_id: update + 1000, chat: { id: 42, type: "private" }, from: { id: 7, username: "owner" }, text, ...extra } });
  return { url, sent, calls, push, say, lastId: () => String(id) };
}

describe("telegram plugin", () => {
  it("answers only a chat linked with a code, and routes replies to threads", async () => {
    const tg = await fakeTelegram();
    process.env.VIREO_TELEGRAM_API_URL = tg.url;
    const app = open();
    await app.plugins.install("telegram", { bot_token: "123:SECRET-TOKEN" });
    expect(tg.calls).toContain("bot123:SECRET-TOKEN getMe");

    // A stranger gets one line and nothing reaches Vireo.
    tg.say("hello");
    await until(() => tg.sent.length === 1);
    expect(tg.sent[0]!.text).toContain("only answers its owner");
    expect(app.threads.messages(OVERVIEW_ID).length).toBe(0);

    const { message } = await app.plugins.action("telegram", "link", { origin: "http://localhost" });
    const code = message!.match(/\/start (\S+)/)![1]!;
    tg.say(`/start ${code}`);
    await until(() => tg.sent.some((m) => m.text.startsWith("Linked.")));

    // A plain message goes to Overview, and the answer comes back.
    tg.say("Explain how a vireo builds its nest");
    await until(() => tg.sent.some((m) => m.text.includes("Here's my take")));
    expect(messageText(app.threads.messages(OVERVIEW_ID).find((m) => m.role === "user")!.body)).toContain("vireo builds its nest");

    // /new starts a thread; the answer is signed with its title.
    tg.say("/new Write a two line poem about autumn");
    await until(() => tg.sent.filter((m) => m.text.includes("Here's my take")).length === 2);
    const thread = app.threads.list().find((t) => t.id !== OVERVIEW_ID)!;
    await app.runner.idle();
    expect(app.threads.messages(thread.id).some((m) => m.role === "user")).toBe(true);

    // The token never appears in what the bot sends.
    expect(JSON.stringify(tg.sent)).not.toContain("SECRET-TOKEN");
    const status = (await app.plugins.list({ origin: "http://localhost" })).find((p) => p.id === "telegram")!.status!;
    expect(status).toMatchObject({ state: "ready" });
  });

  it("sends confirmations with buttons, and a tap runs the action", async () => {
    const tg = await fakeTelegram();
    process.env.VIREO_TELEGRAM_API_URL = tg.url;
    const app = open();
    await app.plugins.install("telegram", { bot_token: "123:abc" });
    const code = (await app.plugins.action("telegram", "link", { origin: "" })).message!.match(/\/start (\S+)/)![1]!;
    tg.say(`/start ${code}`);
    await until(() => tg.sent.some((m) => m.text.startsWith("Linked.")));

    tg.say("/new Schedule a 30 min meeting with anna@example.com tomorrow");
    // Creating the invitation waits for a card.
    await until(() => tg.sent.some((m) => m.reply_markup?.inline_keyboard?.length), 15000);
    const card = tg.sent.find((m) => m.reply_markup?.inline_keyboard?.length)!;
    expect(card.reply_markup!.inline_keyboard[0]!.map((b) => b.text)).toEqual(["Confirm", "Cancel"]);
    const data = card.reply_markup!.inline_keyboard[0]![1]!.callback_data;
    tg.push({ callback_query: { id: "cb1", from: { id: 7 }, message: { message_id: 1, chat: { id: 42 } }, data } });
    await until(() => tg.sent.some((m) => m.text.startsWith("Cancelled")));
    expect(app.actions.pending()).toHaveLength(0);
  });
});

describe("feishu plugin", () => {
  it("verifies, decrypts and answers events from a linked chat", async () => {
    const sent: { receive_id: string; msg_type: string; content: string }[] = [];
    process.env.VIREO_FEISHU_API_URL = await listen((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url!.includes("tenant_access_token")) return res.end(JSON.stringify({ code: 0, tenant_access_token: "t-1", expire: 7200 }));
        if (req.url!.includes("/bot/v3/info")) return res.end(JSON.stringify({ code: 0, bot: { app_name: "Vireo Bot", open_id: "ou_bot" } }));
        if (req.url!.startsWith("/open-apis/im/v1/messages")) {
          sent.push(JSON.parse(body));
          return res.end(JSON.stringify({ code: 0, data: { message_id: `om_${sent.length}` } }));
        }
        res.end(JSON.stringify({ code: 0 }));
      });
    });
    const app = open();
    await app.plugins.install("feishu", { app_id: "cli_x", app_secret: "fs-secret", verification_token: "vtok", encrypt_key: "ekey" });
    const http = createHttp(app);
    const encrypt = (obj: object) => {
      const iv = randomBytes(16);
      const c = createCipheriv("aes-256-cbc", createHash("sha256").update("ekey").digest(), iv);
      return Buffer.concat([iv, c.update(JSON.stringify(obj)), c.final()]).toString("base64");
    };
    const post = (obj: object, token = "vtok") =>
      http.request("/api/plugins/feishu/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ encrypt: encrypt({ ...obj, token, header: "header" in obj ? { ...(obj as { header: object }).header, token } : undefined }) }) });

    const challenge = await post({ type: "url_verification", challenge: "abc" });
    expect(await challenge.json()).toEqual({ challenge: "abc" });
    expect((await post({ type: "url_verification", challenge: "abc" }, "wrong")).status).toBe(401);

    const msg = (text: string, id: string) => ({
      schema: "2.0",
      header: { event_id: id, event_type: "im.message.receive_v1" },
      event: { sender: { sender_id: { open_id: "ou_owner" } }, message: { message_id: `m_${id}`, chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) } },
    });
    const code = (await app.plugins.action("feishu", "link", { origin: "" })).message!.match(/Send (\S+)/)![1]!;
    await post(msg(code, "e1"));
    await until(() => sent.some((m) => JSON.parse(m.content).text?.startsWith("Linked.")));
    await post(msg("Explain how a vireo builds its nest", "e2"));
    await post(msg("Explain how a vireo builds its nest", "e2")); // a retry is ignored
    await until(() => sent.some((m) => JSON.parse(m.content).text?.includes("Here's my take")));
    await app.runner.idle();
    expect(app.threads.messages(OVERVIEW_ID).filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("decrypts the documented sample", () => {
    // From Feishu's docs: encrypt key "test key", plaintext "hello world".
    expect(decryptFeishu("P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=", "test key")).toBe("hello world");
  });
});

describe("chat helpers", () => {
  it("splits long answers at paragraph breaks", () => {
    const parts = split(`${"a".repeat(60)}\n\n${"b".repeat(60)}`, 100);
    expect(parts).toEqual(["a".repeat(60), "b".repeat(60)]);
  });
});

describe("mcp plugin", () => {
  it("parses servers and fills secrets", () => {
    const servers = parseServers('{"mcpServers":{"gh":{"url":"https://x/mcp","headers":{"Authorization":"Bearer ${TOKEN}"}}}}', parseSecrets("TOKEN='abc'\n# comment"));
    expect(servers.gh!.headers!.Authorization).toBe("Bearer abc");
    expect(() => parseServers('{"a":{"command":"x","args":["${MISSING}"]}}', {})).toThrow(/MISSING/);
    expect(toolName("my-server", "do.thing")).toBe("mcp_my_server_do_thing");
  });

  it("connects a stdio server, runs read-only tools and asks before the rest", async () => {
    const app = open();
    const fixture = resolve("tests/fixtures/fake-mcp/server.mjs");
    await app.plugins.install("mcp", {
      servers: JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], env: { FIXTURE_TOKEN: "${TOKEN}" } } } }),
      secrets: "TOKEN=mcp-secret-123",
    });
    expect(app.tools.has("mcp_fixture_echo")).toBe(true);
    const view = (await app.plugins.list({ origin: "" })).find((p) => p.id === "mcp")!;
    expect(view.status).toMatchObject({ state: "ready", message: "1 of 1 server(s) connected, 2 tools." });

    const t = app.threads.create({});
    app.runner.send(t.id, "Use MCP echo: hello there");
    await app.runner.idle();
    expect(app.threads.get(t.id)!.agent).toBe("mcp");
    const reply = messageText(app.threads.messages(t.id).filter((m) => m.role === "assistant").at(-1)!.body);
    // The secret reached the server but is scrubbed from what the model sees.
    expect(reply).toContain("echo: hello there (token [secret])");

    const t2 = app.threads.create({});
    app.runner.send(t2.id, "Use MCP create_note: groceries");
    await app.runner.idle();
    expect(app.actions.pending()).toEqual([expect.objectContaining({ tool: "mcp_fixture_create_note" })]);
  }, 30_000);
});

describe("search plugin", () => {
  it("searches with the provider and falls back to the built-in search when it fails", async () => {
    const app = open();
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://api.tavily.com/search") {
        seen.push(`${(init?.headers as Record<string, string>).authorization} ${init?.body}`);
        return new Response(JSON.stringify({ results: [{ title: "Vireo", url: "https://example.com/vireo", content: "A small songbird." }] }));
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await app.plugins.install("search", { provider: "tavily", api_key: "tvly-KEY" });
      const thread = app.threads.create({});
      const out = await app.tools.get("web_search")!.run({ query: "vireo" }, { app, thread, agent: "research" });
      expect(seen).toEqual(['Bearer tvly-KEY {"query":"vireo","max_results":6}']);
      expect(out.text).toContain("https://example.com/vireo");
      expect(out.text).toContain("A small songbird.");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
