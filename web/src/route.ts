import { useEffect, useState } from "react";

export type Route =
  | { name: "thread"; id: string }
  | { name: "new" }
  | { name: "memory" }
  | { name: "settings" }
  | { name: "home" };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  if (h.startsWith("thread/")) return { name: "thread", id: decodeURIComponent(h.slice(7)) };
  if (h === "new") return { name: "new" };
  if (h === "memory") return { name: "memory" };
  if (h === "settings") return { name: "settings" };
  return { name: "home" };
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
