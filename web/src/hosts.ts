/**
 * Hosts: the Vireo app is only the UI; each host (this machine, a VPS, a
 * home server) runs its own agent with its own threads and memory. The app
 * keeps a list of paired hosts and talks to one at a time.
 *
 * "This machine" is the host the app server proxies at /api (same origin,
 * cookie sign-in). Other hosts are reached directly with the token they
 * issued at pairing.
 */

export interface Host {
  id: string;
  name: string;
  /** Base URL; "" is this machine, through the app's own /api. */
  url: string;
  token?: string;
}

const LIST = "vireo.hosts";
const CURRENT = "vireo.host";
/** The owner's own name for this machine; unset shows "This machine". */
const LOCAL_NAME = "vireo.host.local.name";
export const LOCAL_ID = "local";
export const LOCAL_DEFAULT_NAME = "This machine";
/** Fired on window when a host is renamed, so every place showing its name updates. */
export const HOSTS_CHANGED = "vireo:hosts-changed";

function local(): Host {
  let name = "";
  try {
    name = localStorage.getItem(LOCAL_NAME)?.trim() ?? "";
  } catch {
    // Storage blocked: keep the default name.
  }
  return { id: LOCAL_ID, name: name || LOCAL_DEFAULT_NAME, url: "" };
}

function stored(): Host[] {
  try {
    const list = JSON.parse(localStorage.getItem(LIST) ?? "[]") as Host[];
    return Array.isArray(list) ? list.filter((h) => h && typeof h.url === "string" && h.id !== LOCAL_ID) : [];
  } catch {
    return [];
  }
}

let hasLocal = true;

/** Asks the app server whether it proxies a host on this machine. */
export async function initHosts(): Promise<void> {
  try {
    const r = await fetch("/app-config.json", { cache: "no-store" });
    const cfg = (await r.json()) as { localHost?: boolean };
    hasLocal = cfg.localHost !== false;
  } catch {
    // Vite's dev server has no app config and proxies /api to the local host.
    hasLocal = true;
  }
}

export function hosts(): Host[] {
  return [...(hasLocal ? [local()] : []), ...stored()];
}

export function currentHost(): Host | undefined {
  const id = localStorage.getItem(CURRENT);
  const all = hosts();
  return all.find((h) => h.id === id) ?? all[0];
}

export function hostUrl(path: string, host = currentHost()): string {
  return `${host?.url ?? ""}${path}`;
}

/** For URLs the browser loads itself (images, links, EventSource). */
export function authedUrl(path: string, host = currentHost()): string {
  const url = hostUrl(path, host);
  if (!host?.token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(host.token)}`;
}

function save(list: Host[]): void {
  localStorage.setItem(LIST, JSON.stringify(list.filter((h) => h.id !== LOCAL_ID)));
}

/** Switches to another host; the app reloads so nothing from the old one lingers. */
export function switchHost(id: string): void {
  localStorage.setItem(CURRENT, id);
  location.hash = "";
  location.reload();
}

/** Renames a host on this device; an empty name puts this machine back to "This machine". */
export function renameHost(id: string, name: string): void {
  if (id === LOCAL_ID) {
    const clean = name.trim().slice(0, 60);
    if (!clean || clean === LOCAL_DEFAULT_NAME) localStorage.removeItem(LOCAL_NAME);
    else localStorage.setItem(LOCAL_NAME, clean);
  } else {
    save(stored().map((h) => (h.id === id ? { ...h, name: name.trim() || h.name } : h)));
  }
  window.dispatchEvent(new Event(HOSTS_CHANGED));
}

export function removeHost(id: string): void {
  const h = stored().find((x) => x.id === id);
  // Best effort: end the session on the host too.
  if (h?.token) void fetch(`${h.url}/api/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${h.token}` } }).catch(() => undefined);
  save(stored().filter((x) => x.id !== id));
  if (localStorage.getItem(CURRENT) === id) localStorage.removeItem(CURRENT);
}

/** Stores a token from a password sign-in on a remote host. */
export function setToken(id: string, token: string): void {
  save(stored().map((h) => (h.id === id ? { ...h, token } : h)));
}

/**
 * Reads what the owner pasted: an address ("vps.example.com:8787") or the
 * pairing link a host prints ("http://10.0.0.5:8787#pair=K7QM2XPA").
 */
export function parsePairing(input: string, code = ""): { url: string; code: string } {
  let text = input.trim();
  let found = code.trim();
  const m = /#pair=([0-9A-Za-z-]+)/.exec(text);
  if (m) {
    found ||= m[1]!;
    text = text.slice(0, m.index);
  }
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  const u = new URL(text);
  return { url: u.origin, code: found };
}

export class PairingError extends Error {}

/** Pairs with a host using a one-time code and makes it current. */
export async function pairHost(input: string, codeInput = "", existingId?: string): Promise<Host> {
  let parsed: { url: string; code: string };
  try {
    parsed = parsePairing(input, codeInput);
  } catch {
    throw new PairingError("That doesn't look like an address. Try something like 203.0.113.5:8787.");
  }
  if (!parsed.code) throw new PairingError("Enter the pairing code the host printed.");
  if (location.protocol === "https:" && parsed.url.startsWith("http:")) {
    throw new PairingError("This app is on HTTPS, so the browser blocks plain-HTTP hosts. Give the host an HTTPS address (for example with tailscale serve or Caddy).");
  }
  let res: Response;
  try {
    res = await fetch(`${parsed.url}/api/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: parsed.code, label: deviceLabel(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
  } catch {
    throw new PairingError(`Couldn't reach ${parsed.url}. Check the address, that the host is running, and that its port is open.`);
  }
  const data = (await res.json().catch(() => ({}))) as { token?: string; name?: string; error?: string };
  if (!res.ok || !data.token) throw new PairingError(data.error ?? `The host answered ${res.status}.`);
  const list = stored();
  const prior = list.find((h) => h.id === existingId) ?? list.find((h) => h.url === parsed.url);
  const host: Host = { id: prior?.id ?? `h_${Date.now().toString(36)}`, name: prior?.name ?? data.name ?? new URL(parsed.url).hostname, url: parsed.url, token: data.token };
  save([...list.filter((h) => h.id !== host.id), host]);
  localStorage.setItem(CURRENT, host.id);
  return host;
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Linux";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser} on ${os} (${location.host})`;
}
