import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { Type } from "typebox";
import type { Config } from "../config.js";
import { truncate } from "../util.js";
import { defineTool, untrustedBlock } from "./types.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

/**
 * Web search with no API key required: DuckDuckGo's HTML endpoint by default,
 * or SearXNG / Brave when configured.
 */
export async function webSearch(config: Config, query: string, max = 8): Promise<SearchResult[]> {
  if (config.searchEndpoint) {
    const res = await fetch(`${config.searchEndpoint}?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    return ((await res.json()) as SearchResult[]).slice(0, max);
  }
  if (config.searxngUrl) {
    const res = await fetch(`${config.searxngUrl.replace(/\/$/, "")}/search?format=json&q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`SearXNG search failed: ${res.status}`);
    const body = (await res.json()) as { results: { title: string; url: string; content?: string }[] };
    return body.results.slice(0, max).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
  }
  if (config.braveApiKey) {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?count=${max}&q=${encodeURIComponent(query)}`, {
      headers: { "X-Subscription-Token": config.braveApiKey, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Brave search failed: ${res.status}`);
    const body = (await res.json()) as { web?: { results: { title: string; url: string; description: string }[] } };
    return (body.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: stripTags(r.description) }));
  }
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: new URLSearchParams({ q: query }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  const { document } = parseHTML(await res.text());
  const out: SearchResult[] = [];
  for (const node of document.querySelectorAll(".result")) {
    const a = node.querySelector("a.result__a");
    if (!a) continue;
    let href = a.getAttribute("href") ?? "";
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) href = decodeURIComponent(m[1]!);
    if (href.startsWith("//")) href = `https:${href}`;
    if (!/^https?:/.test(href) || href.includes("duckduckgo.com/y.js")) continue;
    out.push({
      title: a.textContent?.trim() ?? href,
      url: href,
      snippet: node.querySelector(".result__snippet")?.textContent?.trim() ?? "",
    });
    if (out.length >= max) break;
  }
  return out;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

export async function fetchReadable(url: string): Promise<{ title: string; text: string; url: string }> {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http(s) URLs can be fetched");
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Fetching ${url} failed: ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  const buf = Buffer.from(await res.arrayBuffer()).subarray(0, 3_000_000);
  if (type.includes("pdf")) throw new Error("PDF pages cannot be read yet; try an HTML version of the document.");
  const raw = buf.toString("utf8");
  if (!type.includes("html")) return { title: url, text: raw, url: res.url || url };
  const { document } = parseHTML(raw);
  const title = document.querySelector("title")?.textContent?.trim() ?? url;
  let text = "";
  try {
    const article = new Readability(document as unknown as Document).parse();
    text = article?.textContent ?? "";
  } catch {
    // fall back to plain body text
  }
  if (text.trim().length < 200) {
    const { document: d2 } = parseHTML(raw);
    for (const el of d2.querySelectorAll("script,style,noscript,nav,footer,svg")) el.remove();
    text = d2.body?.textContent ?? "";
  }
  return { title, text: text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim(), url: res.url || url };
}

export const researchTools = [
  defineTool({
    name: "web_search",
    label: "Search the web",
    description: "Search the web. Returns titles, URLs and snippets. Read promising results with fetch_page.",
    parameters: Type.Object({
      query: Type.String(),
      max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
    }),
    untrusted: true,
    async run(args, ctx) {
      const results = await webSearch(ctx.app.config, args.query, args.max_results ?? 6);
      if (results.length === 0) return { text: "No results." };
      return {
        text: untrustedBlock(
          "web search",
          results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n"),
        ),
        details: { results },
      };
    },
  }),
  defineTool({
    name: "fetch_page",
    label: "Read page",
    description: "Fetch a web page or document and return its readable text.",
    parameters: Type.Object({ url: Type.String() }),
    untrusted: true,
    async run(args, ctx) {
      const page = await fetchReadable(args.url);
      ctx.app.threads.addRelated(ctx.thread.id, { kind: "page", title: page.title, url: page.url });
      return {
        text: untrustedBlock(page.url, `Title: ${page.title}\nURL: ${page.url}\n\n${truncate(page.text, 15000)}`),
        details: { url: page.url, title: page.title },
      };
    },
  }),
];
