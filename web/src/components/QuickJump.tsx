import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Thread } from "../api";
import type { Card } from "../cards/types";
import { relTime } from "../format";
import { ArrowUpIcon, HomeIcon, MemoryIcon, SettingsIcon } from "../icons";
import { go } from "../route";

interface Item {
  key: string;
  title: string;
  sub: string;
  tag?: "needs" | "working";
  icon?: "home" | "memory" | "settings" | "ask";
  run: () => void | Promise<void>;
}

const PAGES: { title: string; hash: string; icon: Item["icon"] }[] = [
  { title: "Home", hash: "", icon: "home" },
  { title: "Memory", hash: "memory", icon: "memory" },
  { title: "Settings", hash: "settings", icon: "settings" },
];

/** Every word of the query appears somewhere in the text, in any order. */
function matches(text: string, query: string): boolean {
  const hay = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/**
 * ⌘K: jump to any matter by its name, its card or what it is doing, or ask
 * Vireo something new straight from the keyboard.
 */
export function QuickJump({ threads, onClose }: { threads: Thread[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [cards, setCards] = useState<Card[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    input.current?.focus();
    api
      .get<{ cards: Card[] }>("/api/cards")
      .then((r) => setCards(r.cards))
      .catch(() => undefined);
  }, []);

  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    const cardOf = new Map<string, Card>();
    // A matter's own card names it best; derived cards (a confirmation, a reminder) don't name the matter.
    for (const c of cards) if (!cardOf.has(c.threadId) && !["proposal", "reminder", "thread"].includes(c.kind)) cardOf.set(c.threadId, c);
    const rank = (t: Thread) => (t.needsYou ? 0 : t.running ? 1 : t.group === "in_progress" ? 2 : 3);
    const found = threads
      .filter((t) => {
        // Overview only carries chat-app conversations; asking happens on the board.
        if (t.group === "overview") return false;
        if (!q) return t.group !== "done";
        const card = cardOf.get(t.id);
        return matches([t.title, card?.title ?? "", t.statusLine, t.summary ?? ""].join(" "), q);
      })
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
      .slice(0, 8)
      .map<Item>((t) => {
        const card = cardOf.get(t.id);
        const status = t.running ? t.statusLine || "Working…" : t.needsYou ? "Needs you" : t.group === "done" ? "Done" : "";
        return {
          key: t.id,
          // Named as in the sidebar; the card's own title, when it says more, goes underneath.
          title: t.title,
          sub: [status, card && card.title !== t.title ? card.title : "", relTime(t.updatedAt)].filter(Boolean).join(" · "),
          tag: t.needsYou ? "needs" : t.running ? "working" : undefined,
          run: () => go(`thread/${t.id}`),
        };
      });
    const pages = PAGES.filter((p) => q && matches(p.title, q)).map<Item>((p) => ({
      key: `page:${p.hash}`,
      title: p.title,
      sub: "",
      icon: p.icon,
      run: () => go(p.hash),
    }));
    const ask: Item[] = q
      ? [
          {
            key: "ask",
            title: q,
            sub: "Ask Vireo as a new matter",
            icon: "ask",
            run: async () => {
              const { thread } = await api.post<{ thread: Thread }>("/api/threads", { text: q });
              go(`thread/${thread.id}`);
            },
          },
        ]
      : [];
    // A query that finds nothing is most likely a new ask; one that finds a matter most likely meant it.
    return found.length ? [...found, ...pages, ...ask] : [...ask, ...pages];
  }, [query, threads, cards]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const pick = async (item: Item | undefined) => {
    if (!item || busy) return;
    setBusy(true);
    try {
      await item.run();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qj" data-testid="quick-jump" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="qj-box" role="dialog" aria-modal="true" aria-label="Jump to">
        <input
          ref={input}
          className="qj-input"
          placeholder="Jump to a matter, or ask something new"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void pick(items[index]);
            }
          }}
          data-testid="quick-jump-input"
        />
        {items.length ? (
          <ul className="qj-list" ref={list} role="listbox">
            {items.map((item, i) => (
              <li
                key={item.key}
                data-index={i}
                role="option"
                aria-selected={i === index}
                className={`qj-item ${i === index ? "on" : ""}`}
                onMouseMove={() => setIndex(i)}
                onClick={() => void pick(item)}
                data-testid="quick-jump-item"
              >
                <span className={`qj-icon ${item.tag ?? ""} ${item.icon ?? ""}`}>
                  {item.icon === "home" ? (
                    <HomeIcon />
                  ) : item.icon === "memory" ? (
                    <MemoryIcon />
                  ) : item.icon === "settings" ? (
                    <SettingsIcon />
                  ) : item.icon === "ask" ? (
                    <ArrowUpIcon />
                  ) : (
                    <span className="qj-dot" />
                  )}
                </span>
                <span className="qj-text">
                  <span className="qj-title">{item.title}</span>
                  {item.sub ? <span className="qj-sub">{item.sub}</span> : null}
                </span>
                {i === index ? <kbd className="qj-enter">↵</kbd> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="qj-empty">Type to find a matter or ask something new.</p>
        )}
      </div>
    </div>
  );
}
