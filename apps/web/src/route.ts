import { useEffect, useState } from "react";

export type Route =
  | { name: "thread"; id: string }
  | { name: "new" }
  | { name: "threads" }
  | { name: "memory" }
  | { name: "settings"; section: string }
  | { name: "home" };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  if (h.startsWith("thread/")) return { name: "thread", id: decodeURIComponent(h.slice(7)) };
  if (h === "new") return { name: "new" };
  if (h === "threads") return { name: "threads" };
  if (h === "memory") return { name: "memory" };
  if (h === "settings" || h.startsWith("settings/")) return { name: "settings", section: h.slice(9) || "general" };
  return { name: "home" };
}

/**
 * Text shared into the installed app from another app (the manifest's share
 * target opens /share?title=…&text=…&url=…). Read once, then the address
 * goes back to the board, where it waits in the ask box.
 */
let shared = (() => {
  if (location.pathname !== "/share") return "";
  const q = new URLSearchParams(location.search);
  const parts = [q.get("title"), q.get("text"), q.get("url")].map((s) => s?.trim() ?? "").filter(Boolean);
  // Apps often repeat the link inside the text; keep each piece once.
  const text = parts.filter((p, i) => !parts.some((o, j) => j !== i && o.includes(p) && (o.length > p.length || j < i))).join("\n");
  history.replaceState(null, "", "/#");
  return text;
})();

export function sharedText(): string {
  return shared;
}

export function clearShared(): void {
  shared = "";
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(hash: string): void {
  location.hash = hash;
}
