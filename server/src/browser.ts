import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { App } from "./app.js";
import { normaliseDomain } from "./vault.js";

/**
 * Browser work runs in a dedicated, persistent Chromium profile inside
 * Vireo's data directory — never the owner's personal browser (S5). Each
 * thread gets its own tab and may only navigate to sites the task opened.
 */

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: { ref: string; tag: string; type?: string; label: string; href?: string; value?: string }[];
}

interface ElementInfo {
  tag: string;
  type: string;
  text: string;
  inForm: boolean;
  formHasPassword: boolean;
  formAction?: string;
}

const RISKY_TEXT =
  /\b(submit|send|pay|purchase|buy|order|checkout|check out|book|reserve|confirm|place order|sign up|register|delete|remove|transfer)\b|提交|支付|付款|购买|下单|预订|预定|确认|发送|删除|注册/i;

export class BrowserService {
  private context?: Promise<BrowserContext>;
  private pages = new Map<string, Page>();
  private allowed = new Map<string, Set<string>>();

  constructor(private readonly app: App) {}

  private async ctx(): Promise<BrowserContext> {
    if (!this.context) {
      this.context = (async () => {
        const { chromium } = await import("playwright");
        const ctx = await chromium.launchPersistentContext(join(this.app.config.dataDir, "browser-profile"), {
          headless: this.app.config.browserHeadless,
          executablePath: this.app.config.chromiumPath,
          viewport: { width: 1280, height: 900 },
          acceptDownloads: false,
        });
        ctx.on("close", () => {
          this.context = undefined;
          this.pages.clear();
        });
        return ctx;
      })().catch((err) => {
        this.context = undefined;
        throw new Error(`The browser could not start: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return this.context;
  }

  allowedHosts(threadId: string): string[] {
    return [...(this.allowed.get(threadId) ?? [])];
  }

  private isAllowed(threadId: string, url: string): boolean {
    let host: string;
    try {
      host = normaliseDomain(new URL(url).hostname);
    } catch {
      return true;
    }
    if (url.startsWith("about:") || url.startsWith("data:")) return true;
    for (const h of this.allowed.get(threadId) ?? []) if (host === h || host.endsWith(`.${h}`) || h.endsWith(`.${host}`)) return true;
    return false;
  }

  async page(threadId: string): Promise<Page> {
    const existing = this.pages.get(threadId);
    if (existing && !existing.isClosed()) return existing;
    const ctx = await this.ctx();
    const page = await ctx.newPage();
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !this.isAllowed(threadId, req.url())) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    this.pages.set(threadId, page);
    return page;
  }

  hasPage(threadId: string): boolean {
    const p = this.pages.get(threadId);
    return Boolean(p && !p.isClosed());
  }

  async open(threadId: string, url: string): Promise<PageSnapshot> {
    const host = normaliseDomain(new URL(url).hostname);
    if (!this.allowed.has(threadId)) this.allowed.set(threadId, new Set());
    this.allowed.get(threadId)!.add(host);
    const page = await this.page(threadId);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return this.snapshot(threadId);
  }

  async snapshot(threadId: string): Promise<PageSnapshot> {
    const page = await this.page(threadId);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    return page.evaluate(() => {
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      document.querySelectorAll("[data-vireo-ref]").forEach((e) => e.removeAttribute("data-vireo-ref"));
      const els = document.querySelectorAll(
        "a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[contenteditable=true]",
      );
      const out: { ref: string; tag: string; type?: string; label: string; href?: string; value?: string }[] = [];
      let i = 0;
      for (const el of Array.from(els)) {
        if (!visible(el) || out.length >= 200) continue;
        const ref = `e${++i}`;
        el.setAttribute("data-vireo-ref", ref);
        const input = el as HTMLInputElement;
        const id = el.getAttribute("id");
        const labelEl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest("label");
        const label = (
          el.getAttribute("aria-label") ||
          labelEl?.textContent ||
          input.placeholder ||
          el.getAttribute("name") ||
          (el as HTMLElement).innerText ||
          input.value ||
          el.getAttribute("title") ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
        const type = el.tagName === "INPUT" ? input.type : undefined;
        out.push({
          ref,
          tag: el.tagName.toLowerCase(),
          type,
          label,
          href: el.tagName === "A" ? (el as HTMLAnchorElement).href : undefined,
          value:
            (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") && type !== "password"
              ? String(input.value ?? "").slice(0, 80) || undefined
              : undefined,
        });
      }
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 6000),
        elements: out,
      };
    });
  }

  private async element(threadId: string, ref: string) {
    const page = await this.page(threadId);
    const loc = page.locator(`[data-vireo-ref="${ref.replace(/"/g, "")}"]`);
    if ((await loc.count()) === 0) throw new Error(`Element ${ref} not found; take a new snapshot`);
    return { page, loc: loc.first() };
  }

  async describe(threadId: string, ref: string): Promise<ElementInfo> {
    const { loc } = await this.element(threadId, ref);
    return loc.evaluate((el) => {
      const form = el.closest("form");
      return {
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute("type") ?? "").toLowerCase(),
        text: ((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "").trim().slice(0, 80),
        inForm: Boolean(form),
        formHasPassword: Boolean(form?.querySelector("input[type=password]")),
        formAction: form?.getAttribute("action") ?? undefined,
      };
    });
  }

  /** Whether clicking this element would submit, buy or otherwise act outward. */
  async isConsequentialClick(threadId: string, ref: string): Promise<boolean> {
    const info = await this.describe(threadId, ref);
    // Signing in with stored credentials is part of getting the task done, not an outward action.
    if (info.formHasPassword && /^(sign ?in|log ?in|continue|next|登录|登入)$/i.test(info.text)) return false;
    if (info.tag === "input" && ["submit", "image"].includes(info.type)) return true;
    if (info.tag === "button" && info.inForm && (info.type === "" || info.type === "submit")) return true;
    return RISKY_TEXT.test(info.text);
  }

  async click(threadId: string, ref: string): Promise<PageSnapshot> {
    const { page, loc } = await this.element(threadId, ref);
    await loc.click({ timeout: 10000 });
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(300);
    return this.snapshot(threadId);
  }

  /** Types text; {{username}} / {{password}} are filled from the vault for the current site. */
  async type(threadId: string, ref: string, text: string, submit: boolean): Promise<PageSnapshot> {
    const { page, loc } = await this.element(threadId, ref);
    let value = text;
    if (/\{\{(username|password)\}\}/.test(text)) {
      const cred = this.app.vault.forHost(new URL(page.url()).hostname);
      if (!cred) throw new Error(`No stored credentials for ${new URL(page.url()).hostname}. Ask the owner to add them in Settings.`);
      value = text.replace(/\{\{username\}\}/g, cred.username).replace(/\{\{password\}\}/g, cred.password);
    }
    await loc.fill(value, { timeout: 10000 });
    if (submit) {
      await loc.press("Enter");
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(300);
    }
    return this.snapshot(threadId);
  }

  async select(threadId: string, ref: string, value: string): Promise<PageSnapshot> {
    const { loc } = await this.element(threadId, ref);
    await loc.selectOption({ label: value }).catch(() => loc.selectOption(value));
    return this.snapshot(threadId);
  }

  async screenshot(threadId: string): Promise<Buffer> {
    const page = await this.page(threadId);
    return page.screenshot({ type: "png", fullPage: false });
  }

  async closeThread(threadId: string): Promise<void> {
    const p = this.pages.get(threadId);
    this.pages.delete(threadId);
    this.allowed.delete(threadId);
    await p?.close().catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    if (ctx) await (await ctx).close().catch(() => undefined);
  }
}

export function formatSnapshot(s: PageSnapshot): string {
  const els = s.elements
    .map((e) => `[${e.ref}] ${e.tag}${e.type ? `(${e.type})` : ""} "${e.label}"${e.value ? ` value="${e.value}"` : ""}${e.href ? ` → ${e.href}` : ""}`)
    .join("\n");
  return `URL: ${s.url}\nTitle: ${s.title}\n\nInteractive elements:\n${els || "(none)"}\n\nPage text:\n${s.text}`;
}
