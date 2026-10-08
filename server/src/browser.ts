import { join } from "node:path";
import type { BrowserContext, CDPSession, Locator, Page } from "playwright";
import type { App } from "./app.js";
import { normaliseProxy, PROXY_BYPASS } from "./net.js";
import { normaliseDomain } from "./vault.js";

/**
 * Browser work runs in a dedicated, persistent Chromium profile inside
 * Vireo's data directory — never the owner's personal browser (S5). Each
 * thread gets its own tabs. The agent sees pages as Playwright's AI snapshot
 * (an accessibility tree with refs that also cover iframes and clickable
 * divs) and acts on those refs.
 */

export interface PageSnapshot {
  url: string;
  title: string;
  tabs: { index: number; title: string; url: string; current: boolean }[];
  /** Accessibility tree with [ref=…] markers. */
  tree: string;
}

interface ElementInfo {
  tag: string;
  type: string;
  text: string;
  inForm: boolean;
  formHasPassword: boolean;
  formIsSearch: boolean;
  formAction?: string;
}

const RISKY_TEXT =
  /\b(submit|send|pay|purchase|buy|order|checkout|check out|book|reserve|confirm|place order|sign up|register|delete|remove|transfer)\b|提交|支付|付款|购买|下单|预订|预定|确认|发送|删除|注册/i;

/** Navigations shortly after an agent action (clicks, sign-in redirects, SSO) may leave the opened sites. */
const ACTION_WINDOW_MS = 15_000;
const TREE_LIMIT = 24_000;

/** Playwright's snapshot for agents (the one Playwright MCP uses); public in behaviour, untyped in 1.56. */
type AiSnapshotPage = Page & { _snapshotForAI(options?: { timeout?: number }): Promise<string> };

/** One input from the owner while they control the browser; x and y are fractions of the viewport. */
export type OwnerInput =
  | { type: "move" | "down" | "up"; x: number; y: number; button?: "left" | "middle" | "right" }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string };

interface ThreadTabs {
  pages: Page[];
  current?: Page;
  allowed: Set<string>;
  lastAction: number;
}

export class BrowserService {
  private context?: Promise<BrowserContext>;
  private launchedProxy = "";
  private threads = new Map<string, ThreadTabs>();
  private screencasts = new WeakMap<Page, CDPSession>();
  /** Latest frame per thread, kept after the tab closes so the owner can still see where the browser ended up. */
  private frames = new Map<string, Buffer>();
  /** Threads whose browser the owner has taken over; the agent's browser tools wait until it is handed back. */
  private control = new Map<string, { released: Promise<void>; release: () => void; queue: Promise<void> }>();

  constructor(private readonly app: App) {}

  private proxy(): string {
    return normaliseProxy(this.app.settings.get().proxyUrl);
  }

  private async ctx(): Promise<BrowserContext> {
    // A changed proxy takes effect once no thread is using the browser.
    if (this.context && this.launchedProxy !== this.proxy() && !this.anyOpen()) await this.shutdown();
    if (!this.context) {
      const proxy = this.proxy();
      this.launchedProxy = proxy;
      this.context = (async () => {
        const { chromium } = await import("playwright");
        const ctx = await chromium.launchPersistentContext(join(this.app.config.dataDir, "browser-profile"), {
          headless: this.app.config.browserHeadless,
          executablePath: this.app.config.chromiumPath,
          viewport: { width: 1280, height: 900 },
          acceptDownloads: false,
          proxy: proxy ? { server: proxy, bypass: PROXY_BYPASS } : undefined,
          args: ["--disable-blink-features=AutomationControlled"],
        });
        ctx.on("close", () => {
          this.context = undefined;
          this.threads.clear();
        });
        return ctx;
      })().catch((err) => {
        this.context = undefined;
        throw new Error(`The browser could not start: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return this.context;
  }

  private anyOpen(): boolean {
    for (const t of this.threads.values()) if (t.pages.some((p) => !p.isClosed())) return true;
    return false;
  }

  private tabs(threadId: string): ThreadTabs {
    let t = this.threads.get(threadId);
    if (!t) {
      t = { pages: [], allowed: new Set(), lastAction: 0 };
      this.threads.set(threadId, t);
    }
    t.pages = t.pages.filter((p) => !p.isClosed());
    if (t.current?.isClosed()) t.current = t.pages.at(-1);
    return t;
  }

  allowedHosts(threadId: string): string[] {
    return [...(this.threads.get(threadId)?.allowed ?? [])];
  }

  private isAllowed(threadId: string, url: string): boolean {
    if (/^(about|data|blob|chrome-error):/.test(url)) return true;
    let host: string;
    try {
      host = normaliseDomain(new URL(url).hostname);
    } catch {
      return true;
    }
    const t = this.tabs(threadId);
    // Wherever the owner goes by hand is theirs to choose.
    if (this.control.has(threadId)) {
      t.allowed.add(host);
      return true;
    }
    for (const h of t.allowed) if (host === h || host.endsWith(`.${h}`) || h.endsWith(`.${host}`)) return true;
    if (Date.now() - t.lastAction < ACTION_WINDOW_MS) {
      t.allowed.add(host);
      return true;
    }
    return false;
  }

  /** Marks that the agent just acted, so the navigation it causes is allowed. */
  private acted(threadId: string): void {
    this.tabs(threadId).lastAction = Date.now();
  }

  private async adopt(threadId: string, page: Page): Promise<void> {
    const t = this.tabs(threadId);
    if (t.pages.includes(page)) return;
    t.pages.push(page);
    t.current = page;
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !this.isAllowed(threadId, req.url())) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    // Links with target=_blank and window.open land in a new tab; follow it.
    page.on("popup", (popup) => void this.adopt(threadId, popup).catch(() => undefined));
    page.on("close", () => {
      const tt = this.threads.get(threadId);
      if (!tt) return;
      tt.pages = tt.pages.filter((p) => p !== page);
      if (tt.current === page) tt.current = tt.pages.at(-1);
      if (tt.current) void this.screencast(threadId, tt.current);
    });
    await this.screencast(threadId, page);
  }

  /** Streams frames of the thread's current tab into the live view. */
  private async screencast(threadId: string, page: Page): Promise<void> {
    if (this.screencasts.has(page) || page.isClosed()) return;
    try {
      const cdp = await page.context().newCDPSession(page);
      this.screencasts.set(page, cdp);
      cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
        if (this.threads.get(threadId)?.current === page) this.frames.set(threadId, Buffer.from(f.data, "base64"));
        void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 900 });
    } catch {
      // The live view falls back to screenshots.
    }
  }

  async page(threadId: string): Promise<Page> {
    const t = this.tabs(threadId);
    if (t.current) return t.current;
    const ctx = await this.ctx();
    const page = await ctx.newPage();
    await this.adopt(threadId, page);
    return page;
  }

  hasPage(threadId: string): boolean {
    return Boolean(this.tabs(threadId).current);
  }

  async open(threadId: string, url: string, newTab = false): Promise<PageSnapshot> {
    const t = this.tabs(threadId);
    t.allowed.add(normaliseDomain(new URL(url).hostname));
    let page: Page;
    if (newTab && t.current) {
      page = await (await this.ctx()).newPage();
      await this.adopt(threadId, page);
    } else {
      page = await this.page(threadId);
    }
    this.acted(threadId);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.settle(page);
    return this.snapshot(threadId);
  }

  private nextPopup(page: Page): Promise<Page | null> {
    return page.waitForEvent("popup", { timeout: 1500 }).catch(() => null);
  }

  /** Lets the page settle and switches the thread to a tab the action opened, if any. */
  private async afterAction(threadId: string, page: Page, popup: Promise<Page | null>): Promise<void> {
    const [p] = await Promise.all([popup, this.settle(page)]);
    if (!p) return;
    await this.adopt(threadId, p);
    this.tabs(threadId).current = p;
    await this.settle(p);
  }

  /** Waits for the page to stop changing after an action, without hanging on long-polling sites. */
  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
  }

  async snapshot(threadId: string): Promise<PageSnapshot> {
    const t = this.tabs(threadId);
    const page = await this.page(threadId);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    let tree = await (page as AiSnapshotPage)._snapshotForAI({ timeout: 10000 });
    if (tree.length > TREE_LIMIT) tree = `${tree.slice(0, TREE_LIMIT)}\n- … (truncated; scroll or use browser_read for the rest)`;
    const tabs = await Promise.all(
      t.pages.map(async (p, index) => ({ index, title: await p.title().catch(() => ""), url: p.url(), current: p === page })),
    );
    return { url: page.url(), title: await page.title().catch(() => ""), tabs, tree };
  }

  /** The page's readable text, for long articles and result lists. */
  async read(threadId: string): Promise<{ url: string; title: string; text: string }> {
    const page = await this.page(threadId);
    const text = await page.evaluate(() => (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n"));
    return { url: page.url(), title: await page.title().catch(() => ""), text: text.slice(0, 20000) };
  }

  private async element(threadId: string, ref: string): Promise<{ page: Page; loc: Locator }> {
    const page = await this.page(threadId);
    const clean = ref.trim().replace(/^\[?ref=/, "").replace(/\]$/, "");
    const loc = page.locator(`aria-ref=${clean}`);
    const n = await loc.count().catch(() => 0);
    if (n === 0) throw new Error(`Element ${ref} is not on the page any more; call browser_snapshot for fresh refs`);
    return { page, loc: loc.first() };
  }

  async describe(threadId: string, ref: string): Promise<ElementInfo> {
    const { loc } = await this.element(threadId, ref);
    return loc.evaluate((el) => {
      const form = el.closest("form");
      const action = form?.getAttribute("action") ?? "";
      return {
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute("type") ?? "").toLowerCase(),
        text: ((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "").trim().slice(0, 80),
        inForm: Boolean(form),
        formHasPassword: Boolean(form?.querySelector("input[type=password]")),
        formIsSearch: Boolean(
          form &&
            (form.getAttribute("role") === "search" ||
              el.closest("[role=search]") ||
              /search|query|\/s\b|\/find/i.test(action) ||
              form.querySelector("input[type=search],input[name=q],input[name=query],input[name=wd],input[name=keyword]")),
        ),
        formAction: action || undefined,
      };
    });
  }

  /** Whether clicking this element would submit, buy or otherwise act outward. */
  async isConsequentialClick(threadId: string, ref: string): Promise<boolean> {
    const info = await this.describe(threadId, ref);
    // Signing in with stored credentials and searching are part of getting the task done, not outward actions.
    if (info.formHasPassword && /^(sign ?in|log ?in|continue|next|登录|登入|下一步)$/i.test(info.text)) return false;
    if (info.formIsSearch && !RISKY_TEXT.test(info.text)) return false;
    if (info.tag === "input" && ["submit", "image"].includes(info.type)) return true;
    if (info.tag === "button" && info.inForm && (info.type === "" || info.type === "submit")) return true;
    return RISKY_TEXT.test(info.text);
  }

  /** Whether pressing Enter in this field would submit a form that acts outward. */
  async isConsequentialSubmit(threadId: string, ref: string | undefined): Promise<boolean> {
    if (!ref) {
      const page = await this.page(threadId);
      const inForm = await page.evaluate(() => Boolean(document.activeElement?.closest("form"))).catch(() => false);
      return inForm;
    }
    const info = await this.describe(threadId, ref);
    if (!info.inForm) return false;
    return !info.formIsSearch && !info.formHasPassword;
  }

  async click(threadId: string, ref: string, double = false): Promise<PageSnapshot> {
    const { page, loc } = await this.element(threadId, ref);
    this.acted(threadId);
    const popup = this.nextPopup(page);
    if (double) await loc.dblclick({ timeout: 10000 });
    else await loc.click({ timeout: 10000 });
    await this.afterAction(threadId, page, popup);
    return this.snapshot(threadId);
  }

  async hover(threadId: string, ref: string): Promise<PageSnapshot> {
    const { page, loc } = await this.element(threadId, ref);
    await loc.hover({ timeout: 10000 });
    await page.waitForTimeout(400);
    return this.snapshot(threadId);
  }

  /** Types text; {{username}} / {{password}} are filled from the vault for the current site. */
  async type(threadId: string, ref: string, text: string, submit: boolean, slowly = false): Promise<PageSnapshot> {
    const { page, loc } = await this.element(threadId, ref);
    let value = text;
    if (/\{\{(username|password)\}\}/.test(text)) {
      const cred = this.app.vault.forHost(new URL(page.url()).hostname);
      if (!cred) throw new Error(`No stored credentials for ${new URL(page.url()).hostname}. Ask the owner to add them in Settings.`);
      value = text.replace(/\{\{username\}\}/g, cred.username).replace(/\{\{password\}\}/g, cred.password);
    }
    if (slowly) {
      // Key by key, for fields whose autocomplete only reacts to real key presses.
      await loc.click({ timeout: 10000 });
      await loc.press("ControlOrMeta+a");
      await loc.press("Backspace");
      await loc.pressSequentially(value, { delay: 40 });
    } else {
      await loc.fill(value, { timeout: 10000 });
    }
    if (submit) {
      this.acted(threadId);
      await loc.press("Enter");
      await this.settle(page);
    } else {
      await page.waitForTimeout(300);
    }
    return this.snapshot(threadId);
  }

  async press(threadId: string, key: string, ref?: string): Promise<PageSnapshot> {
    this.acted(threadId);
    const page = await this.page(threadId);
    const popup = this.nextPopup(page);
    if (ref) await (await this.element(threadId, ref)).loc.press(key, { timeout: 10000 });
    else await page.keyboard.press(key);
    await this.afterAction(threadId, page, popup);
    return this.snapshot(threadId);
  }

  async select(threadId: string, ref: string, values: string[]): Promise<PageSnapshot> {
    const { page, loc } = await this.element(threadId, ref);
    await loc.selectOption(values.map((label) => ({ label }))).catch(() => loc.selectOption(values));
    await page.waitForTimeout(300);
    return this.snapshot(threadId);
  }

  async check(threadId: string, ref: string, checked: boolean): Promise<PageSnapshot> {
    const { page, loc } = await this.element(threadId, ref);
    await loc.setChecked(checked, { timeout: 10000 });
    await page.waitForTimeout(300);
    return this.snapshot(threadId);
  }

  async scroll(threadId: string, direction: "up" | "down", ref?: string): Promise<PageSnapshot> {
    const page = await this.page(threadId);
    if (ref) {
      const { loc } = await this.element(threadId, ref);
      await loc.scrollIntoViewIfNeeded({ timeout: 10000 });
    } else {
      await page.mouse.move(640, 450);
      await page.mouse.wheel(0, direction === "down" ? 800 : -800);
    }
    // Lazy lists load more items once scrolled.
    await page.waitForTimeout(700);
    return this.snapshot(threadId);
  }

  async wait(threadId: string, opts: { text?: string; seconds?: number }): Promise<PageSnapshot> {
    const page = await this.page(threadId);
    if (opts.text) await page.getByText(opts.text).first().waitFor({ state: "visible", timeout: 20000 });
    else await page.waitForTimeout(Math.min(Math.max(opts.seconds ?? 2, 0.5), 20) * 1000);
    return this.snapshot(threadId);
  }

  async history(threadId: string, direction: "back" | "forward"): Promise<PageSnapshot> {
    const page = await this.page(threadId);
    this.acted(threadId);
    if (direction === "back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
    else await page.goForward({ waitUntil: "domcontentloaded", timeout: 15000 });
    await this.settle(page);
    return this.snapshot(threadId);
  }

  async selectTab(threadId: string, index: number): Promise<PageSnapshot> {
    const t = this.tabs(threadId);
    const page = t.pages[index];
    if (!page) throw new Error(`There is no tab ${index}; this thread has ${t.pages.length}`);
    t.current = page;
    await page.bringToFront().catch(() => undefined);
    await this.screencast(threadId, page);
    return this.snapshot(threadId);
  }

  async closeTab(threadId: string, index?: number): Promise<PageSnapshot> {
    const t = this.tabs(threadId);
    const page = index === undefined ? t.current : t.pages[index];
    if (!page) throw new Error(`There is no tab ${index}`);
    await page.close();
    return this.snapshot(threadId);
  }

  async screenshot(threadId: string): Promise<Buffer> {
    const page = await this.page(threadId);
    return page.screenshot({ type: "png", fullPage: false });
  }

  /** The latest JPEG of the thread's current tab for the live view; the last frame once the tab is gone. */
  async frame(threadId: string): Promise<Buffer | null> {
    const t = this.threads.get(threadId);
    const page = t?.current && !t.current.isClosed() ? t.current : undefined;
    if (page && (!this.screencasts.has(page) || !this.frames.has(threadId))) {
      const shot = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false, timeout: 5000 }).catch(() => null);
      if (shot) this.frames.set(threadId, shot);
    }
    return this.frames.get(threadId) ?? null;
  }

  isControlled(threadId: string): boolean {
    return this.control.has(threadId);
  }

  /** The owner takes the thread's browser; returns false when there is no open tab to take. */
  takeOver(threadId: string): boolean {
    if (!this.hasPage(threadId)) return false;
    if (!this.control.has(threadId)) {
      let release = () => {};
      const released = new Promise<void>((r) => (release = r));
      this.control.set(threadId, { released, release, queue: Promise.resolve() });
    }
    return true;
  }

  handBack(threadId: string): void {
    this.control.get(threadId)?.release();
    this.control.delete(threadId);
  }

  /** Resolves once the owner hands the browser back; true when the agent had to wait. */
  async waitForOwner(threadId: string, signal?: AbortSignal): Promise<boolean> {
    const c = this.control.get(threadId);
    if (!c) return false;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("Stopped"));
      signal?.addEventListener("abort", () => reject(new Error("Stopped")), { once: true });
      void c.released.then(resolve);
    });
    return true;
  }

  /** Replays the owner's mouse and keyboard on the current tab, in order. */
  input(threadId: string, ev: OwnerInput): Promise<void> {
    const c = this.control.get(threadId);
    if (!c) return Promise.reject(new Error("Take over the browser first"));
    const run = async () => {
      const t = this.tabs(threadId);
      const page = t.current;
      if (!page) return;
      const vp = page.viewportSize() ?? { width: 1280, height: 900 };
      const at = (e: { x: number; y: number }) => [Math.round(clamp01(e.x) * vp.width), Math.round(clamp01(e.y) * vp.height)] as const;
      switch (ev.type) {
        case "move":
          await page.mouse.move(...at(ev));
          break;
        case "down":
          await page.mouse.move(...at(ev));
          await page.mouse.down({ button: ev.button ?? "left" });
          break;
        case "up":
          await page.mouse.move(...at(ev));
          await page.mouse.up({ button: ev.button ?? "left" });
          break;
        case "wheel":
          await page.mouse.move(...at(ev));
          await page.mouse.wheel(ev.dx, ev.dy);
          break;
        case "key":
          await page.keyboard.press(ev.key);
          break;
        case "text":
          await page.keyboard.insertText(ev.text);
          break;
      }
    };
    const next = c.queue.then(run);
    c.queue = next.catch(() => undefined);
    return next;
  }

  async closeThread(threadId: string): Promise<void> {
    this.handBack(threadId);
    const t = this.threads.get(threadId);
    this.threads.delete(threadId);
    for (const p of t?.pages ?? []) await p.close().catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.control.keys()]) this.handBack(id);
    const ctx = this.context;
    this.context = undefined;
    this.threads.clear();
    if (ctx) await (await ctx).close().catch(() => undefined);
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export function formatSnapshot(s: PageSnapshot): string {
  const tabs =
    s.tabs.length > 1 ? `\nTabs:\n${s.tabs.map((t) => `${t.current ? "*" : " "} [${t.index}] ${t.title || "(untitled)"} — ${t.url}`).join("\n")}\n` : "";
  return `URL: ${s.url}\nTitle: ${s.title}\n${tabs}\nPage (act on elements by their ref, e.g. e12):\n${s.tree || "(empty page)"}`;
}
