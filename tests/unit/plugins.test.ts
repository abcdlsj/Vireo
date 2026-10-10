import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../apps/host/src/app.js";
import { AGENTS } from "../../apps/host/src/agents.js";
import { Db } from "../../apps/host/src/db.js";
import { buildSystemPrompt } from "../../apps/host/src/prompt.js";
import { messageText } from "../../apps/host/src/threads.js";
import { tempDir, testApp } from "./helpers.js";

const FAKE_TS = resolve("tests/fixtures/fake-tailscale");

let apps: App[] = [];
let servers: Server[] = [];
afterEach(async () => {
  for (const app of apps) {
    await app.runner.idle();
    await app.plugins.stop();
    await app.browser.shutdown();
    try {
      app.db.close();
    } catch {
      // already closed
    }
  }
  for (const s of servers) s.close();
  apps = [];
  servers = [];
});

function open(dir?: string): App {
  const app = testApp(dir);
  apps.push(app);
  return app;
}

const lastReply = (app: App, threadId: string) =>
  messageText(
    app.threads
      .messages(threadId)
      .filter((m) => m.role === "assistant")
      .at(-1)!.body,
  );

describe("plugins", () => {
  it("adds a plugin's tools and agent only while it is installed", async () => {
    const app = open();
    expect(app.tools.has("tailnet_machines")).toBe(false);
    await app.plugins.install("tailscale", { mode: "system", bin_dir: FAKE_TS });
    expect(app.tools.has("tailnet_ssh")).toBe(true);
    const view = (await app.plugins.list({ origin: "http://localhost" })).find((p) => p.id === "tailscale")!;
    expect(view.status).toMatchObject({ state: "ready" });
    expect(view.status!.message).toContain("vireo");
    await app.plugins.uninstall("tailscale");
    expect(app.tools.has("tailnet_machines")).toBe(false);
  });

  it("stores secret settings encrypted and never returns them", async () => {
    const dir = tempDir();
    const app = open(dir);
    await app.plugins.install("tailscale", { mode: "system", bin_dir: FAKE_TS, api_key: "tskey-api-SECRET123" });
    const raw = JSON.stringify(app.db.getKv("plugins"));
    expect(raw).not.toContain("tskey-api-SECRET123");
    const view = (await app.plugins.list({ origin: "http://localhost" })).find((p) => p.id === "tailscale")!;
    expect(JSON.stringify(view)).not.toContain("SECRET123");
    expect(view.fields.find((f) => f.key === "api_key")?.set).toBe(true);
    expect(app.vault.redact("key tskey-api-SECRET123 here")).toBe("key [secret] here");
    // Omitting a secret keeps it; an empty string clears it.
    await app.plugins.configure("tailscale", { hostname: "home" });
    expect(app.plugins.config("tailscale").api_key).toBe("tskey-api-SECRET123");
    await app.plugins.configure("tailscale", { api_key: "" });
    expect(app.plugins.config("tailscale").api_key).toBe("");
  });

  it("moves a Google connection made before plugins into the Google plugin", () => {
    const dir = tempDir();
    const db = Db.open(dir);
    db.setKv("google.client", { clientId: "cid.apps.googleusercontent.com", clientSecret: "gsecret-1" });
    db.setKv("google.tokens", { access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3600_000, email: "owner@example.com" });
    db.close();
    const app = open(dir);
    expect(app.plugins.installed("google")).toBe(true);
    expect(app.plugins.config("google")).toMatchObject({ client_id: "cid.apps.googleusercontent.com", client_secret: "gsecret-1" });
    expect(app.db.getKv("google.client")).toBeUndefined();
    expect(app.integrations.status().google).toMatchObject({ installed: true, connected: true, email: "owner@example.com" });
  });
});

describe("capabilities", () => {
  it("tells the assistant which plugins are missing or unfinished", async () => {
    const app = open();
    await app.plugins.install("search", { provider: "tavily" });
    const caps = app.plugins.capabilities();
    expect(caps.find((c) => c.id === "tailscale")).toMatchObject({ state: "not_added" });
    expect(caps.find((c) => c.id === "search")).toMatchObject({ state: "needs_setup", message: expect.stringContaining("API key") });
    const t = app.threads.create({ title: "Check my NAS" });
    const prompt = buildSystemPrompt(app, AGENTS.general!, app.threads.get(t.id)!, "", AGENTS);
    expect(prompt).toContain("- tailscale: Tailscale.");
    expect(prompt).toMatch(/- tailscale: .*not added \(Vireo can set it up in its browser/);
    expect(prompt).toContain("added, needs setup: Add a Tavily API key");
    expect(prompt).toContain("call suggest_setup");
  });

  it("links to the plugin's settings and carries on once it is ready", async () => {
    const app = open();
    const t = app.threads.create({ title: "Check my NAS" });
    const thread = app.threads.get(t.id)!;
    const out = await app.tools.get("suggest_setup")!.run({ plugin: "tailscale" }, { app, thread, agent: "general" });
    expect(out.text).toContain("[Tailscale](#settings/plugins/tailscale)");
    expect(out.text).toContain("hand off to browser, which calls plugin_setup");
    await expect(app.tools.get("suggest_setup")!.run({ plugin: "nope" }, { app, thread, agent: "general" })).rejects.toThrow("Unknown plugin");

    await app.plugins.install("tailscale", { mode: "system", bin_dir: FAKE_TS });
    const resumed = app.threads.messages(t.id).filter((m) => m.role === "user").map((m) => messageText(m.body));
    expect(resumed.at(-1)).toContain("Tailscale is set up now");
    // Once is enough: a later refresh does not resume it again.
    await app.plugins.refreshStatuses();
    expect(app.threads.messages(t.id).filter((m) => m.role === "user")).toHaveLength(resumed.length);
  });
});

describe("tailscale plugin", () => {
  it("lists tailnet machines through the Tailnet specialist", async () => {
    const app = open();
    await app.plugins.install("tailscale", { mode: "system", bin_dir: FAKE_TS });
    const t = app.threads.create({});
    app.runner.send(t.id, "Which of my tailnet machines are online?");
    await app.runner.idle();
    expect(app.threads.get(t.id)!.agent).toBe("tailnet");
    expect(lastReply(app, t.id)).toContain("Online: nas. Offline: old-laptop.");
  });

  it("reaches an HTTP service on a machine over the tailnet", async () => {
    const app = open();
    await app.plugins.install("tailscale", { mode: "system", bin_dir: FAKE_TS });
    const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("nas is healthy"));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const thread = app.threads.create({});
    const out = await app.tools.get("tailnet_http")!.run({ machine: "nas", port, path: "/health" }, { app, thread, agent: "tailnet" });
    expect(out.text).toContain("HTTP 200");
    expect(out.text).toContain("nas is healthy");
    expect(out.text).toContain("<untrusted_content");
  });

  it("asks the owner before running a command over SSH", async () => {
    const app = open();
    await app.plugins.install("tailscale", { mode: "system", bin_dir: FAKE_TS });
    const t = app.threads.create({});
    app.runner.send(t.id, "Run `df -h` on nas over ssh");
    await app.runner.idle();
    const [pending] = app.actions.pending();
    expect(pending).toMatchObject({ threadId: t.id, tool: "tailnet_ssh", summary: "Run on nas: df -h" });
  });

  it("needs an API token to manage devices", async () => {
    const app = open();
    await app.plugins.install("tailscale", { mode: "system", bin_dir: FAKE_TS });
    const thread = app.threads.create({});
    await expect(app.tools.get("tailnet_device")!.run({ machine: "nas", action: "authorize" }, { app, thread, agent: "tailnet", confirmed: true })).rejects.toThrow(/API token/);
  });

  it("manages devices through the Tailscale API", async () => {
    const calls: string[] = [];
    const api = createServer((req, res) => {
      calls.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/tailnet/-/devices")) {
        res.end(JSON.stringify({ devices: [{ id: "dev-nas", name: "nas.tail-test.ts.net", hostname: "nas", addresses: ["100.64.0.2"], os: "linux", authorized: false, expires: "2027-01-01T00:00:00Z" }] }));
      } else res.end("{}");
    });
    servers.push(api);
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    process.env.VIREO_TAILSCALE_API_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    try {
      const app = open();
      await app.plugins.install("tailscale", { mode: "system", bin_dir: FAKE_TS, api_key: "tskey-api-abc" });
      const thread = app.threads.create({});
      const ctx = { app, thread, agent: "tailnet", confirmed: true };
      expect((await app.tools.get("tailnet_machines")!.run({}, ctx)).text).toContain("NOT AUTHORISED");
      await app.tools.get("tailnet_device")!.run({ machine: "nas", action: "authorize" }, ctx);
      expect(calls).toContain("POST /device/dev-nas/authorized Bearer tskey-api-abc");
      expect(app.tools.get("tailnet_device")!.confirm?.({ machine: "nas", action: "remove" }, ctx)).toBe(true);
    } finally {
      delete process.env.VIREO_TAILSCALE_API_URL;
    }
  });
});

describe("google plugin", () => {
  it("reads Google Drive once the plugin is added", async () => {
    const app = open();
    const t = app.threads.create({});
    app.runner.send(t.id, "In my drive, find the Lisbon trip plan");
    await app.runner.idle();
    expect(lastReply(app, t.id)).not.toContain("LX-4821");

    await app.plugins.install("google");
    const t2 = app.threads.create({});
    app.runner.send(t2.id, "In my drive, find the Lisbon trip plan");
    await app.runner.idle();
    expect(lastReply(app, t2.id)).toContain("LX-4821");
  });
});
