import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../apps/host/src/app.js";
import { formatSnapshot } from "../../apps/host/src/browser.js";
import { normaliseProxy } from "../../apps/host/src/net.js";
import { resolve } from "node:path";
import { testApp } from "./helpers.js";

const PAGES: Record<string, string> = {
  "/": `<h1>Home</h1>
    <div style="cursor:pointer" onclick="document.getElementById('out').textContent='div clicked'">Fancy button</div>
    <p id="out"></p>
    <iframe srcdoc="<button onclick=&quot;this.textContent='inner clicked'&quot;>Inner</button>"></iframe>
    <a href="/second" target="_blank">Open in new tab</a>
    <form action="/search" role="search"><input name="q" aria-label="Search"></form>
    <form action="/book" method="post"><label for="n">Name</label><input id="n" name="n"><button>Book table</button></form>`,
  "/second": `<h1>Second page</h1>`,
  "/keys": `<h1>Access token created</h1>
    <p>Copy it now; it is shown only once.</p>
    <input aria-label="Token" readonly value="tskey-api-kQx7Ab3CNTRL-Zp9sWm2Lr8VbT4yHc6NdJf">
    <button>Done</button>`,
};

let server: Server;
let base = "";
let app: App;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>${path}</title>${PAGES[path] ?? "<p>other</p>"}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app = testApp();
});

afterAll(async () => {
  await app.browser.shutdown();
  app.db.close();
  server.close();
});

const ref = (tree: string, pattern: RegExp) => tree.split("\n").find((l) => pattern.test(l))?.match(/\[ref=(\w+)\]/)?.[1];

describe("browser", () => {
  it("acts on clickable divs and elements inside iframes through snapshot refs", async () => {
    const t = app.threads.create({});
    let snap = await app.browser.open(t.id, `${base}/`);
    expect(formatSnapshot(snap)).toContain("[ref=");
    snap = await app.browser.click(t.id, ref(snap.tree, /Fancy button/)!);
    expect(snap.tree).toContain("div clicked");
    const inner = ref(snap.tree, /button "Inner"/)!;
    expect(inner).toMatch(/^f\d+e\d+$/);
    snap = await app.browser.click(t.id, inner);
    expect(snap.tree).toContain("inner clicked");
  });

  it("follows links that open a new tab and lists the tabs", async () => {
    const t = app.threads.create({});
    let snap = await app.browser.open(t.id, `${base}/`);
    snap = await app.browser.click(t.id, ref(snap.tree, /link "Open in new tab"/)!);
    expect(snap.title).toBe("/second");
    expect(snap.tabs).toHaveLength(2);
    snap = await app.browser.selectTab(t.id, 0);
    expect(snap.title).toBe("/");
  });

  it("does not ask for confirmation to search, but does to book", async () => {
    const t = app.threads.create({});
    const snap = await app.browser.open(t.id, `${base}/`);
    expect(await app.browser.isConsequentialSubmit(t.id, ref(snap.tree, /textbox "Search"/))).toBe(false);
    expect(await app.browser.isConsequentialSubmit(t.id, ref(snap.tree, /textbox "Name"/))).toBe(true);
    expect(await app.browser.isConsequentialClick(t.id, ref(snap.tree, /button "Book table"/)!)).toBe(true);
  });

  it("streams frames of the current tab for the live view", async () => {
    const t = app.threads.create({});
    await app.browser.open(t.id, `${base}/second`);
    const frame = await app.browser.frame(t.id);
    expect(frame?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("lets the owner take over by hand while the agent's browser steps wait", async () => {
    const t = app.threads.create({});
    expect(app.browser.takeOver(t.id)).toBe(false);
    await app.browser.open(t.id, `${base}/`);
    expect(app.browser.takeOver(t.id)).toBe(true);

    let resumed = false;
    const agent = app.browser.waitForOwner(t.id).then((waited) => (resumed = waited));

    // Click the fancy button by its position, then type into the search field.
    const page = await app.browser.page(t.id);
    const vp = page.viewportSize()!;
    const box = (await page.getByText("Fancy button").boundingBox())!;
    const at = { x: (box.x + box.width / 2) / vp.width, y: (box.y + box.height / 2) / vp.height };
    await app.browser.input(t.id, { type: "down", ...at });
    await app.browser.input(t.id, { type: "up", ...at });
    await page.getByLabel("Search").focus();
    await app.browser.input(t.id, { type: "text", text: "hello" });
    await app.browser.input(t.id, { type: "key", key: "Backspace" });
    expect(await page.locator("#out").textContent()).toBe("div clicked");
    expect(await page.getByLabel("Search").inputValue()).toBe("hell");
    expect(resumed).toBe(false);

    app.browser.handBack(t.id);
    await agent;
    expect(resumed).toBe(true);
    await expect(app.browser.input(t.id, { type: "key", key: "a" })).rejects.toThrow(/Take over/);
  });

  it("stops waiting for the owner when the run is stopped", async () => {
    const t = app.threads.create({});
    await app.browser.open(t.id, `${base}/second`);
    app.browser.takeOver(t.id);
    const stop = new AbortController();
    const wait = app.browser.waitForOwner(t.id, stop.signal);
    stop.abort();
    await expect(wait).rejects.toThrow(/Stopped/);
    app.browser.handBack(t.id);
  });
});

describe("browser-assisted setup", () => {
  const KEY = "tskey-api-kQx7Ab3CNTRL-Zp9sWm2Lr8VbT4yHc6NdJf";

  it("hands the browser to the owner with a request and resumes when it comes back", async () => {
    const t = app.threads.create({});
    await expect(app.browser.askOwner(t.id, "Sign in", 1000)).rejects.toThrow(/browser_open/);
    await app.browser.open(t.id, `${base}/second`);
    const asked = app.browser.askOwner(t.id, "Sign in to Tailscale", 60_000);
    expect(app.browser.isControlled(t.id)).toBe(true);
    expect(app.browser.request(t.id)).toBe("Sign in to Tailscale");
    app.browser.handBack(t.id);
    expect(await asked).toBe(true);

    // Not handed back in time: the agent gets the browser again.
    expect(await app.browser.askOwner(t.id, "Sign in", 50)).toBe(false);
    expect(app.browser.isControlled(t.id)).toBe(false);
  });

  it("hides a key it recognises from the model and saves it straight into the plugin", async () => {
    await app.plugins.install("tailscale", { mode: "system", bin_dir: resolve("tests/fixtures/fake-tailscale") });
    try {
      const t = app.threads.create({});
      const snap = await app.browser.open(t.id, `${base}/keys`);
      expect(snap.tree).not.toContain(KEY);
      expect(snap.tree).toContain("[hidden Tailscale API access token");
      expect((await app.browser.read(t.id)).text).not.toContain(KEY);

      const thread = app.threads.get(t.id)!;
      const out = await app.tools.get("plugin_save_from_page")!.run({ plugin: "tailscale", field: "api_key" }, { app, thread, agent: "browser" });
      expect(out.text).toContain("Saved the API access token to Tailscale");
      expect(out.text).not.toContain(KEY);
      expect(app.plugins.config("tailscale").api_key).toBe(KEY);
      // A field the key does not fit is refused.
      await expect(app.plugins.saveValue("tailscale", "auth_key", KEY)).rejects.toThrow(/does not look like/);
    } finally {
      await app.plugins.uninstall("tailscale");
    }
  });

  it("gives the steps, the sign-in state and which settings are filled", async () => {
    await app.plugins.install("tailscale", { mode: "system", bin_dir: resolve("tests/fixtures/fake-tailscale") });
    try {
      const thread = app.threads.get(app.threads.create({}).id)!;
      const out = await app.tools.get("plugin_setup")!.run({ plugin: "tailscale" }, { app, thread, agent: "browser" });
      expect(out.text).toContain("Tailscale: ready");
      expect(out.text).toContain("- api_key (API access token): not set");
      expect(out.text).toContain("Generate access token");
      expect(out.text).toContain("plugin_save_from_page");
      const google = await app.tools.get("plugin_setup")!.run({ plugin: "google" }, { app, thread, agent: "browser" });
      expect(google.text).toContain("#settings/plugins/google");
    } finally {
      await app.plugins.uninstall("tailscale");
    }
  });
});

describe("proxy setting", () => {
  it("accepts host:port and full URLs", () => {
    expect(normaliseProxy("127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(normaliseProxy(" socks5://127.0.0.1:7891 ")).toBe("socks5://127.0.0.1:7891");
    expect(normaliseProxy("")).toBe("");
  });
});
