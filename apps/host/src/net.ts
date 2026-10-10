import http from "node:http";

/** Local addresses never go through the proxy (LiteLLM, SearXNG, test fixtures). */
export const PROXY_BYPASS = "localhost,127.0.0.1,::1";

let current = "";
let restore: (() => void) | undefined;

/** Normalises "127.0.0.1:7890" to "http://127.0.0.1:7890"; empty means no proxy. */
export function normaliseProxy(url: string | undefined): string {
  const v = (url ?? "").trim();
  if (!v) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`;
}

/** Routes Node's fetch and http(s) through the proxy, or back to direct connections. */
export function applyProxy(url: string | undefined): void {
  const next = normaliseProxy(url);
  if (next === current) return;
  const setGlobal = (http as unknown as { setGlobalProxyFromEnv?: (env: Record<string, string>) => () => void }).setGlobalProxyFromEnv;
  if (!setGlobal) {
    if (next) console.warn("[vireo] This Node version cannot set a proxy at runtime; set HTTPS_PROXY and NODE_USE_ENV_PROXY=1 instead.");
    return;
  }
  restore?.();
  restore = next ? setGlobal({ HTTP_PROXY: next, HTTPS_PROXY: next, NO_PROXY: PROXY_BYPASS }) : undefined;
  current = next;
}
