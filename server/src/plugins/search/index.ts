import { errorMessage } from "../../util.js";
import type { SearchResult } from "../../tools/research.js";
import type { PluginDef, PluginStatus } from "../types.js";

/**
 * Search providers: replaces the keyless DuckDuckGo search with a search API
 * (Tavily, Exa, Serper, Jina, Bocha), and reads pages Vireo cannot read by
 * itself (script-heavy sites, PDFs) through Jina Reader.
 */

type Provider = "tavily" | "exa" | "serper" | "jina" | "bocha";

interface SearchConfig {
  provider: Provider;
  api_key: string;
  reader: "fallback" | "always" | "off";
  reader_key: string;
}

const UA = { "user-agent": "Vireo" };

async function post<T>(url: string, headers: Record<string, string>, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...UA, ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

const cut = (s: string | undefined, n = 400) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export async function providerSearch(provider: Provider, key: string, query: string, max: number): Promise<SearchResult[]> {
  switch (provider) {
    case "tavily": {
      const r = await post<{ results: { title: string; url: string; content: string }[] }>("https://api.tavily.com/search", { authorization: `Bearer ${key}` }, { query, max_results: max });
      return r.results.map((x) => ({ title: x.title, url: x.url, snippet: cut(x.content) }));
    }
    case "exa": {
      const r = await post<{ results: { title: string | null; url: string; text?: string; highlights?: string[] }[] }>(
        "https://api.exa.ai/search",
        { "x-api-key": key },
        { query, numResults: max, contents: { highlights: { numSentences: 3 } } },
      );
      return r.results.map((x) => ({ title: x.title ?? x.url, url: x.url, snippet: cut(x.highlights?.join(" … ") ?? x.text) }));
    }
    case "serper": {
      const r = await post<{ organic?: { title: string; link: string; snippet?: string }[] }>("https://google.serper.dev/search", { "x-api-key": key }, { q: query, num: max });
      return (r.organic ?? []).slice(0, max).map((x) => ({ title: x.title, url: x.link, snippet: cut(x.snippet) }));
    }
    case "jina": {
      const res = await fetch(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
        headers: { accept: "application/json", authorization: `Bearer ${key}`, "x-respond-with": "no-content", ...UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`s.jina.ai answered ${res.status}`);
      const r = (await res.json()) as { data?: { title: string; url: string; description?: string; content?: string }[] };
      return (r.data ?? []).slice(0, max).map((x) => ({ title: x.title, url: x.url, snippet: cut(x.description || x.content) }));
    }
    case "bocha": {
      const r = await post<{ data?: { webPages?: { value?: { name: string; url: string; snippet?: string; summary?: string }[] } } }>(
        "https://api.bochaai.com/v1/web-search",
        { authorization: `Bearer ${key}` },
        { query, count: max, summary: true },
      );
      return (r.data?.webPages?.value ?? []).map((x) => ({ title: x.name, url: x.url, snippet: cut(x.summary || x.snippet) }));
    }
  }
}

/** Jina Reader: any URL as readable text, including script-heavy pages and PDFs. */
export async function jinaRead(url: string, key?: string): Promise<{ title: string; text: string; url: string }> {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...UA },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Jina Reader answered ${res.status}`);
  const r = (await res.json()) as { data?: { title?: string; content?: string; url?: string } };
  return { title: r.data?.title || url, text: r.data?.content ?? "", url: r.data?.url || url };
}

const NAMES: Record<Provider, string> = { tavily: "Tavily", exa: "Exa", serper: "Serper (Google)", jina: "Jina", bocha: "Bocha (博查)" };

export const searchPlugin: PluginDef = {
  id: "search",
  name: "Search providers",
  description: "Search with Tavily, Exa, Serper, Jina or Bocha instead of DuckDuckGo, and read script-heavy pages and PDFs through Jina Reader.",
  author: "Vireo community",
  homepage: "https://jina.ai/reader",
  fields: [
    {
      key: "provider",
      label: "Search with",
      type: "select",
      default: "tavily",
      options: (Object.keys(NAMES) as Provider[]).map((p) => ({ value: p, label: NAMES[p] })),
    },
    { key: "api_key", label: "API key", type: "secret", help: "From the provider's dashboard. Without one, Vireo keeps searching with DuckDuckGo." },
    {
      key: "reader",
      label: "Jina Reader for pages",
      type: "select",
      default: "fallback",
      options: [
        { value: "fallback", label: "When a page can't be read directly" },
        { value: "always", label: "For every page" },
        { value: "off", label: "Off" },
      ],
    },
    { key: "reader_key", label: "Jina API key", type: "secret", help: "Optional; raises Jina Reader's rate limit. Uses the API key above when Jina is the search provider." },
  ],
  create(ctx) {
    const cfg = () => ctx.config<SearchConfig>();
    let lastError = "";
    const readerKey = () => cfg().reader_key || (cfg().provider === "jina" ? cfg().api_key : "");
    return {
      tools: [],
      async search(query, max) {
        const c = cfg();
        if (!c.api_key) return undefined;
        try {
          const r = await providerSearch(c.provider || "tavily", c.api_key, query, max);
          lastError = "";
          return r;
        } catch (err) {
          lastError = errorMessage(err);
          throw err;
        }
      },
      reader() {
        const mode = cfg().reader || "fallback";
        if (mode === "off") return undefined;
        return { always: mode === "always", read: (url: string) => jinaRead(url, readerKey() || undefined) };
      },
      async status(): Promise<PluginStatus> {
        const c = cfg();
        const details = [
          { label: "Search", value: c.api_key ? NAMES[c.provider || "tavily"] : "DuckDuckGo (no API key set)" },
          { label: "Pages", value: c.reader === "off" ? "read directly" : c.reader === "always" ? "Jina Reader" : "directly, Jina Reader as fallback" },
        ];
        if (lastError) return { state: "error", message: `Last search failed: ${lastError}`, details };
        if (!c.api_key) return { state: "setup", message: `Add a ${NAMES[c.provider || "tavily"]} API key to search with it.`, details };
        return { state: "ready", message: `Searching with ${NAMES[c.provider || "tavily"]}.`, details };
      },
      secrets: () => [cfg().api_key, cfg().reader_key],
    };
  },
};
