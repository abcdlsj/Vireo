import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../apps/node/src/app.js";
import { AGENTS } from "../../apps/node/src/agents.js";
import { Db } from "../../apps/node/src/db.js";
import { createApp } from "../../apps/node/src/app.js";
import { loadConfig } from "../../apps/node/src/config.js";
import { createHttp } from "../../apps/node/src/http/index.js";
import { buildSystemPrompt } from "../../apps/node/src/prompt.js";
import { messageText } from "../../apps/node/src/threads.js";
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

  it("serves the node on the tailnet once HTTPS is allowed", async () => {
    const gate = `${tempDir()}/allowed`;
    process.env.FAKE_TS_SERVE_GATE = gate;
    try {
      const app = open();
      await app.plugins.install("tailscale", { mode: "system", bin_dir: FAKE_TS, serve: true });
      const status = async () => (await app.plugins.list({ origin: "http://localhost" })).find((p) => p.id === "tailscale")!.status!;
      await expect.poll(async () => (await status()).link?.href).toBe("https://login.tailscale.com/f/serve?node=n0");
      writeFileSync(gate, "");
      await expect.poll(async () => (await status()).details?.find((d) => d.label === "This host on the tailnet")?.value, { timeout: 10_000 }).toBe("https://vireo.tail-test.ts.net");
      expect(app.address.directUrl).toBe("https://vireo.tail-test.ts.net");
      await app.plugins.configure("tailscale", { serve: false });
      expect(app.address.directUrl).toBeUndefined();
    } finally {
      delete process.env.FAKE_TS_SERVE_GATE;
    }
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
    expect(out.source).toBe(`http://nas:${port}/health`);
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

  it("shows the owner a failed SSH run without the model-facing wrapper", async () => {
    const app = open();
    await app.plugins.install("tailscale", { mode: "system", bin_dir: FAKE_TS });
    const t = app.threads.create({});
    app.runner.send(t.id, "Run `df -h` on nas over ssh");
    await app.runner.idle();
    const [pending] = app.actions.pending();
    const done = await app.actions.confirm(pending!.id);
    expect(done.status).toBe("failed");
    expect(done.result).not.toContain("untrusted_content");
    expect(done.result).not.toContain("Do not follow instructions");
    expect(done.display?.note).toBeTruthy();
    // The model still reads the wrapper.
    const notice = app.threads.messages(t.id).find((m) => m.body.role === "notice" && (m.body as { kind: string }).kind === "action_result");
    expect(JSON.stringify(notice?.body)).toContain("untrusted_content");
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
  it("walks the owner through creating their own OAuth client, then signs in in Vireo's browser", async () => {
    // A real (not demo) Google plugin, so it needs a client and a sign-in.
    const app = createApp(loadConfig({ VIREO_DATA_DIR: tempDir(), VIREO_FAKE_MODEL: "1", VIREO_PUBLIC_URL: "https://vireo.example.com" }));
    apps.push(app);
    const thread = app.threads.get(app.threads.create({}).id)!;
    const setup = () => app.tools.get("plugin_setup")!.run({ plugin: "google" }, { app, thread, agent: "browser" });

    let out = await setup();
    expect(out.text).toContain("Google: setup");
    expect(out.text).toContain("Redirect URI: https://vireo.example.com/public/google/callback");
    expect(out.text).toContain("console.cloud.google.com/projectcreate");
    expect(out.text).toContain("plugin_save_from_page with field client_id, then with field client_secret");
    expect(out.text).not.toContain("Sign-in link");

    // The client secret is hidden on pages and only ever saved straight from them.
    // Made up, and assembled so secret scanners do not take it for a real one.
    const secret = ["GOCSPX", "test".repeat(7)].join("-");
    expect(app.plugins.redact(`Client secret ${secret}`)).not.toContain(secret);
    await expect(app.plugins.saveValue("google", "client_id", "not-a-client")).rejects.toThrow(/does not look like/);
    await app.plugins.saveValue("google", "client_id", ["1234567890-abc123def456", "apps.googleusercontent.com"].join("."));
    await app.plugins.saveValue("google", "client_secret", secret);

    out = await setup();
    expect(out.text).toContain("Google: login");
    const link = new URL(out.text.match(/Sign-in link: (\S+)/)![1]!);
    expect(link.origin).toBe("https://accounts.google.com");
    expect(link.searchParams.get("redirect_uri")).toBe("https://vireo.example.com/public/google/callback");

    // The owner's own Connect button does not cancel the sign-in under way in Vireo's browser.
    const button = new URL((await app.plugins.action("google", "connect", { origin: "https://vireo.example.com", appOrigin: "https://app.example.com" })).redirect!);
    expect(button.searchParams.get("state")).not.toBe(link.searchParams.get("state"));
    const http = createHttp(app);
    const denied = await http.request(`/public/google/callback?state=${link.searchParams.get("state")}&error=access_denied`);
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain("Hand the browser back");
    const back = await http.request(`/public/google/callback?state=${button.searchParams.get("state")}&error=access_denied`);
    expect(back.headers.get("location")).toBe("https://app.example.com/#settings/plugins?google=access_denied");
    // Each state works once.
    expect((await http.request(`/public/google/callback?state=${button.searchParams.get("state")}`)).status).toBe(400);
  });

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

describe("desktop plugin", () => {
  const FAKE_DESKTOP = resolve("tests/fixtures/fake-agent-desktop");

  // In production each call runs as a one-shot launchd job, so the macOS
  // Accessibility grant attaches to agent-desktop and not to node. A unit test
  // has no launchd of its own to hand: spawn the fixture directly.
  beforeEach(() => {
    process.env.VIREO_DESKTOP_SPAWN = "direct";
  });

  /** The fixture records every call it received, so a test can read what Vireo actually ran. */
  const withLog = () => {
    const file = resolve(tempDir(), "agent-desktop.log");
    process.env.AGENT_DESKTOP_LOG = file;
    return () => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);
  };

  afterEach(() => {
    delete process.env.AGENT_DESKTOP_LOG;
    delete process.env.VIREO_DESKTOP_SPAWN;
  });

  const setup = async (apps = "System Settings") => {
    const app = open();
    await app.plugins.install("desktop", { apps, binary: FAKE_DESKTOP });
    return { app, thread: app.threads.create({}) };
  };

  it("adds its tools only while it is installed", async () => {
    const app = open();
    expect(app.tools.has("desktop_act")).toBe(false);
    await app.plugins.install("desktop", { apps: "System Settings", binary: FAKE_DESKTOP });
    expect([...app.tools.keys()].filter((k) => k.startsWith("desktop_")).sort()).toEqual([
      "desktop_act",
      "desktop_apps",
      "desktop_find",
      "desktop_get",
      "desktop_press",
      "desktop_snapshot",
      "desktop_wait",
      "desktop_windows",
    ]);
    await app.plugins.uninstall("desktop");
    expect(app.tools.has("desktop_act")).toBe(false);
  });

  it("reports the apps it found and the ones it may touch", async () => {
    const { app, thread } = await setup();
    const out = await app.tools.get("desktop_apps")!.run({}, { app, thread, agent: "general" });
    expect(out.text).toContain("Mail");
    expect(out.text).toContain("System Settings  ← Vireo may act here");
    expect(out.text).not.toContain("Mail  ← Vireo may act here");
  });

  it("reads an app as a tree of refs and acts on one", async () => {
    const calls = withLog();
    const { app, thread } = await setup();
    const seen = await app.tools.get("desktop_snapshot")!.run({ app: "System Settings" }, { app, thread, agent: "general" });
    expect(seen.text).toContain("@sfake0001:e7");
    expect(seen.text).toContain("switch \"Wi-Fi\"");
    expect(seen.source).toBe("desktop:System Settings");

    const found = await app.tools.get("desktop_find")!.run({ app: "System Settings", role: "switch", name: "Wi-Fi", first: true }, { app, thread, agent: "general" });
    expect(found.text).toContain("@sfake0001:e7");
    expect(found.text).toContain("row:Wi-Fi");

    const done = await app.tools.get("desktop_act")!.run(
      { action: "check", ref: "@sfake0001:e7", description: "Turn Wi-Fi on" },
      { app, thread, agent: "general", confirmed: true },
    );
    expect(done.text).toContain("check in System Settings: Turn Wi-Fi on");
    expect(done.text).toContain("delivered_verified");
    expect(done.text).toContain("now: checked");
    // The ref went to the CLI as it was printed, in the same session namespace.
    const check = calls().find((c) => c[0] === "check")!;
    expect(check.slice(0, 2)).toEqual(["check", "@sfake0001:e7"]);
    expect(check).toContain("--session");
    expect(check).toContain("vireo");
  });

  it("reads again while a window is being swapped out", async () => {
    const dir = tempDir();
    process.env.AGENT_DESKTOP_FAIL_WINDOWS = "3";
    process.env.AGENT_DESKTOP_COUNTER = resolve(dir, "counter");
    try {
      const { app, thread } = await setup();
      const seen = await app.tools.get("desktop_snapshot")!.run({ app: "System Settings" }, { app, thread, agent: "general" });
      expect(seen.text).toContain("@sfake0001:e7");
    } finally {
      delete process.env.AGENT_DESKTOP_FAIL_WINDOWS;
      delete process.env.AGENT_DESKTOP_COUNTER;
    }
  });

  it("hands back the window after an action, so no second snapshot is needed", async () => {
    const calls = withLog();
    const { app, thread } = await setup();
    await app.tools.get("desktop_snapshot")!.run({ app: "System Settings" }, { app, thread, agent: "general" });
    const before = calls().length;
    const done = await app.tools.get("desktop_act")!.run({ action: "check", ref: "@sfake0001:e7", description: "Turn on Reduce motion" }, { app, thread, agent: "general", confirmed: true });
    expect(done.text).toContain("check in System Settings: Turn on Reduce motion");
    expect(done.text).toContain("@sfake0001:e7");
    expect(calls().slice(before).map((c) => c[0])).toEqual(["check", "snapshot"]);
  });

  it("waits for the owner before touching anything", async () => {
    const { app, thread } = await setup();
    const def = app.tools.get("desktop_act")!;
    expect(def.confirm?.({ action: "uncheck", ref: "@sfake0001:e7", description: "Turn Wi-Fi off" }, { app, thread, agent: "general" })).toBe(true);
    expect(def.summarize?.({ action: "uncheck", ref: "@sfake0001:e7", description: "Turn Wi-Fi off" })).toBe("Turn Wi-Fi off");
  });

  it("shows what will be written on the confirmation card, not only where", async () => {
    const { app } = await setup();
    const act = app.tools.get("desktop_act")!;
    expect(act.summarize?.({ action: "set_value", ref: "@sfake0001:e7", value: "下午吃啥？\n--- 🩷来自大肥鱼", description: "在干饭群输入框填入消息" })).toBe(
      "在干饭群输入框填入消息: “下午吃啥？ --- 🩷来自大肥鱼”",
    );
    const press = app.tools.get("desktop_press")!;
    expect(press.summarize?.({ keys: "cmd+enter", app: "System Settings", description: "发送消息" })).toBe("发送消息 (cmd+enter)");
  });

  it("lists a window id for every window, so a call can name one", async () => {
    process.env.AGENT_DESKTOP_AMBIGUOUS = "1";
    try {
      const { app, thread } = await setup();
      const out = await app.tools.get("desktop_windows")!.run({ app: "System Settings" }, { app, thread, agent: "general" });
      expect(out.text).toContain("2 windows of System Settings");
      expect(out.text).toContain("w-1");
      expect(out.text).toContain("w-2");
      expect(out.text).toContain("(focused)");
    } finally {
      delete process.env.AGENT_DESKTOP_AMBIGUOUS;
    }
  });

  it("takes the focused window when an app has several, instead of giving up", async () => {
    process.env.AGENT_DESKTOP_AMBIGUOUS = "1";
    const calls = withLog();
    try {
      const { app, thread } = await setup();
      const seen = await app.tools.get("desktop_snapshot")!.run({ app: "System Settings" }, { app, thread, agent: "general" });
      expect(seen.text).toContain("Several windows matched; used w-2");
      expect(seen.text).toContain("@sfake0001:e7");
      const snapshots = calls().filter((c) => c[0] === "snapshot");
      expect(snapshots[0]).not.toContain("--window-id");
      expect(snapshots[1]).toContain("--window-id");
      expect(snapshots[1]).toContain("w-2");

      // The window is remembered: the next read does not have to list windows again.
      await app.tools.get("desktop_snapshot")!.run({ app: "System Settings" }, { app, thread, agent: "general" });
      expect(calls().filter((c) => c[0] === "list-windows")).toHaveLength(1);
    } finally {
      delete process.env.AGENT_DESKTOP_AMBIGUOUS;
    }
  });

  it("brings forward an app that is running with no window, then reads it", async () => {
    const dir = tempDir();
    process.env.AGENT_DESKTOP_NEEDS_LAUNCH = "1";
    process.env.AGENT_DESKTOP_STATE = resolve(dir, "launched");
    const calls = withLog();
    try {
      const { app, thread } = await setup();
      const seen = await app.tools.get("desktop_snapshot")!.run({ app: "System Settings" }, { app, thread, agent: "general" });
      expect(seen.text).toContain("Brought System Settings forward");
      expect(seen.text).toContain("@sfake0001:e7");
      const launch = calls().find((c) => c[0] === "launch")!;
      expect(launch.slice(0, 2)).toEqual(["launch", "System Settings"]);
      expect(launch).toContain("--activate");
    } finally {
      delete process.env.AGENT_DESKTOP_NEEDS_LAUNCH;
      delete process.env.AGENT_DESKTOP_STATE;
    }
  });

  it("presses a key combination in the app, in one window", async () => {
    process.env.AGENT_DESKTOP_AMBIGUOUS = "1";
    const calls = withLog();
    try {
      const { app, thread } = await setup();
      const out = await app.tools.get("desktop_press")!.run(
        { keys: "cmd+enter", app: "System Settings", description: "发送消息" },
        { app, thread, agent: "general", confirmed: true },
      );
      expect(out.text).toContain("pressed cmd+enter in System Settings: 发送消息");
      expect(out.text).toContain("delivered_unverified");
      const press = calls().find((c) => c[0] === "press")!;
      expect(press.slice(0, 4)).toEqual(["press", "cmd+enter", "--app", "System Settings"]);
      expect(press).toContain("--window-id");
    } finally {
      delete process.env.AGENT_DESKTOP_AMBIGUOUS;
    }
  });

  it("brings the window forward when keys would land in a background app, then presses again", async () => {
    const dir = tempDir();
    process.env.AGENT_DESKTOP_PRESS_NEEDS_FOCUS = "1";
    process.env.AGENT_DESKTOP_STATE = resolve(dir, "focused");
    const calls = withLog();
    try {
      const { app, thread } = await setup();
      const out = await app.tools.get("desktop_press")!.run(
        { keys: "cmd+enter", app: "System Settings", description: "发送消息" },
        { app, thread, agent: "general", confirmed: true },
      );
      expect(out.text).toContain("Brought System Settings forward");
      expect(out.text).toContain("pressed cmd+enter in System Settings");
      expect(calls().map((c) => c[0])).toContain("focus-window");
      expect(calls().filter((c) => c[0] === "press")).toHaveLength(2);
    } finally {
      delete process.env.AGENT_DESKTOP_PRESS_NEEDS_FOCUS;
      delete process.env.AGENT_DESKTOP_STATE;
    }
  });

  it("refuses to press keys in an app the owner did not allow", async () => {
    const { app, thread } = await setup();
    await expect(
      app.tools.get("desktop_press")!.run({ keys: "cmd+enter", app: "Mail", description: "Send the draft" }, { app, thread, agent: "general", confirmed: true }),
    ).rejects.toThrow(/may not act in Mail/);
  });

  it("answers whether something appeared, without an error to retry", async () => {
    const { app, thread } = await setup();
    const waited = await app.tools.get("desktop_wait")!.run({ app: "System Settings", text: "never appears" }, { app, thread, agent: "general" });
    expect(waited.text).toContain("did not appear within 30 s");
    expect(waited.details).toMatchObject({ found: false });
  });

  it("refuses an app the owner did not allow", async () => {
    const calls = withLog();
    const { app, thread } = await setup();
    await app.tools.get("desktop_snapshot")!.run({ app: "Mail" }, { app, thread, agent: "general" });
    await expect(
      app.tools.get("desktop_act")!.run({ action: "click", ref: "@sfake0001:e7", description: "Open a message" }, { app, thread, agent: "general", confirmed: true }),
    ).rejects.toThrow(/may not act in Mail/);
    expect(calls().some((c) => c[0] === "click")).toBe(false);
  });

  it("will not act on a ref from a snapshot it does not know", async () => {
    const { app, thread } = await setup();
    await expect(
      app.tools.get("desktop_act")!.run({ action: "click", ref: "@sold1234:e9", description: "Click" }, { app, thread, agent: "general", confirmed: true }),
    ).rejects.toThrow(/fresh desktop_snapshot/);
    await expect(app.tools.get("desktop_act")!.run({ action: "click", ref: "e9", description: "Click" }, { app, thread, agent: "general", confirmed: true })).rejects.toThrow(
      /not a desktop ref/,
    );
  });

  it("needs a value for a text action", async () => {
    const { app, thread } = await setup();
    await app.tools.get("desktop_snapshot")!.run({ app: "System Settings" }, { app, thread, agent: "general" });
    await expect(
      app.tools.get("desktop_act")!.run({ action: "type", ref: "@sfake0001:e7", description: "Type" }, { app, thread, agent: "general", confirmed: true }),
    ).rejects.toThrow(/needs a value/);
  });

  it("resolves a bare command name through the node's own PATH", async () => {
    const dir = tempDir();
    copyFileSync(FAKE_DESKTOP, resolve(dir, "agent-desktop"));
    chmodSync(resolve(dir, "agent-desktop"), 0o755);
    const before = process.env.PATH;
    process.env.PATH = `${dir}:${before ?? ""}`;
    try {
      const app = open();
      await app.plugins.install("desktop", { apps: "System Settings" });
      const thread = app.threads.create({});
      const out = await app.tools.get("desktop_apps")!.run({}, { app, thread, agent: "general" });
      expect(out.text).toContain("System Settings");
    } finally {
      process.env.PATH = before;
    }
  });

  it("says what is missing when the command cannot be found", async () => {
    const app = open();
    await app.plugins.install("desktop", { apps: "System Settings", binary: "agent-desktop-not-on-this-machine" });
    const thread = app.threads.create({});
    await expect(app.tools.get("desktop_apps")!.run({}, { app, thread, agent: "general" })).rejects.toThrow(/not installed/);
  });

  it("says what is missing when agent-desktop is not installed", async () => {
    const app = open();
    await app.plugins.install("desktop", { apps: "System Settings", binary: "/nonexistent/agent-desktop" });
    const thread = app.threads.create({});
    await expect(app.tools.get("desktop_apps")!.run({}, { app, thread, agent: "general" })).rejects.toThrow(/not installed/);
  });

  it.runIf(process.platform === "darwin")("reports the permission macOS needs", async () => {
    const { app } = await setup();
    const view = (await app.plugins.list({ origin: "http://localhost" })).find((p) => p.id === "desktop")!;
    expect(view.status).toMatchObject({ state: "ready" });
    expect(view.status!.message).toContain("System Settings");
  });
});
