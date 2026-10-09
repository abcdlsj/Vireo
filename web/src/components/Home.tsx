import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError, onEvent, type Me, type Thread } from "../api";
import { CardSlot } from "../cards/CardSlot";
import { BoardContext, type Board } from "../cards/Frame";
import { Peek } from "../cards/Peek";
import type { Card } from "../cards/types";
import { ArrowUpIcon, CheckIcon, ListIcon, SearchIcon } from "../icons";
import { HostSwitcher } from "./Hosts";

const NUMBERS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/**
 * The home board: what needs the owner, what is in hand, what is being
 * watched, each matter as one card. Asking starts a new matter; its card
 * appears here while Vireo works on it.
 */
export function Home({ me, onSignedOut, onSearch }: { me: Me | null; onSignedOut: () => void; onSearch: () => void }) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [note, setNote] = useState("");
  // The matter open in the peek sheet, by thread: its card can change id as it moves on.
  const [peekThread, setPeekThread] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setCards((await api.get<{ cards: Card[] }>("/api/cards")).cards);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
    }
  }, [onSignedOut]);

  useEffect(() => {
    void load();
    return onEvent((e) => {
      if (
        e.type === "card.updated" ||
        e.type === "thread.updated" ||
        e.type === "thread.deleted" ||
        e.type === "action.updated" ||
        e.type === "message.stream_end"
      ) {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void load(), 150);
      }
    });
  }, [load]);

  const board_ = useMasonry();
  const phone = usePhone();
  const board = useMemo<Board>(() => ({ peek: (c) => setPeekThread(c.threadId), refresh: () => void load(), grouped: true }), [load]);
  const peekCard = peekThread ? (cards ?? []).find((c) => c.threadId === peekThread && !c.id.startsWith("reminder:")) : undefined;

  const active = (cards ?? []).filter((c) => c.status !== "done");
  const done = (cards ?? []).filter((c) => c.status === "done");
  const needs = active.filter((c) => c.status === "needs_you").length;
  const working = active.filter((c) => c.running || c.status === "working").length;
  const headline =
    needs > 0
      ? `${NUMBERS[needs] ?? needs} ${needs === 1 ? "thing needs" : "things need"} you`
      : working > 0
        ? `Working on ${working === 1 ? "one thing" : `${NUMBERS[working]?.toLowerCase() ?? working} things`}`
        : "Nothing needs you";

  return (
    <div className="home" data-testid="home">
      <div className="home-inner">
        {/* On a phone the sidebar is a page of its own; this bar leads to it. */}
        {phone ? (
          <header className="home-bar">
            <a href="#" aria-label="Vireo home" className="home-logo">
              <img src="/icon.svg" alt="" width={26} height={26} />
            </a>
            <HostSwitcher />
            <span className="grow" />
            <button className="home-icon" onClick={onSearch} aria-label="Search">
              <SearchIcon />
            </button>
            <a className="home-icon" href="#threads" aria-label="All matters" data-testid="nav-threads">
              <ListIcon />
              {me && !me.models.ready ? <span className="dot warn" title="No model configured" /> : null}
            </a>
          </header>
        ) : null}

        <div className="home-hero">
          <div className="home-greet">
            <span className="date">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>
            <h1 data-testid="home-headline">{headline}</h1>
          </div>
          <Ask onStarted={load} setNote={setNote} />
        </div>
        {note ? <p className="ask-sent">{note}</p> : null}

        <BoardContext.Provider value={board}>
          <div className="boards" data-testid="board" ref={board_}>
            {cards && active.length === 0 ? (
              <div className="board-empty">
                <b>All clear</b>
                <span>Ask for anything above. Each matter shows up here as a card while Vireo takes care of it.</span>
              </div>
            ) : null}
            {SECTIONS.map((sec) => {
              const items = active.filter((c) => section(c) === sec.key);
              if (!items.length) return null;
              return (
                <section key={sec.key} className={`board-section ${sec.key}`} data-testid={`board-${sec.key}`}>
                  <h2 className="board-head">
                    {sec.label}
                    <span className="count">{items.length}</span>
                  </h2>
                  <div className="board">
                    {items.map((c) => (
                      <CardSlot key={c.id} card={c} refresh={load} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </BoardContext.Provider>

        {done.length ? (
          <div className="done-strip" data-testid="done-strip">
            <span className="label">Done lately</span>
            {done.slice(0, 12).map((c) => (
              <a
                key={c.id}
                className="done-chip"
                href={`#thread/${c.threadId}`}
                title={c.title}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey) return;
                  e.preventDefault();
                  setPeekThread(c.threadId);
                }}
              >
                <CheckIcon />
                {c.title}
              </a>
            ))}
          </div>
        ) : null}
      </div>
      {peekCard ? <Peek key={peekCard.threadId} card={peekCard} onClose={() => setPeekThread(null)} refresh={load} /> : null}
    </div>
  );
}

const SECTIONS = [
  { key: "needs", label: "Needs you" },
  { key: "hand", label: "In hand" },
  { key: "watching", label: "Watching" },
] as const;

/** Where a card sits on the board: what waits on the owner, what Vireo has in hand, what it keeps an eye on. */
function section(c: Card): (typeof SECTIONS)[number]["key"] {
  if (c.status === "needs_you") return "needs";
  if (c.status === "watching" && !c.running) return "watching";
  return "hand";
}

/** True on a phone, where the shell shows one page at a time (see shell.css). */
function usePhone(): boolean {
  const query = "(max-width: 760px)";
  const [phone, setPhone] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

const ROW = 4;
const GAP = 20;

/**
 * Lays the board out as a masonry: every card keeps its natural height, so
 * nothing is cut off and nothing leaves a hole, while the reading order stays
 * left to right. Each slot spans as many 4px rows as its card is tall.
 */
function useMasonry() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const size = (slot: HTMLElement) => {
      const card = slot.firstElementChild as HTMLElement | null;
      if (!card) return;
      slot.style.gridRowEnd = `span ${Math.ceil((card.getBoundingClientRect().height + GAP) / ROW)}`;
    };
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) size((e.target as HTMLElement).parentElement!);
    });
    const watch = () => {
      ro.disconnect();
      for (const slot of grid.querySelectorAll<HTMLElement>(".board > .slot")) {
        if (slot.firstElementChild) ro.observe(slot.firstElementChild);
        size(slot);
      }
    };
    watch();
    // Only slots coming and going matter; a card's own content is the ResizeObserver's job.
    const mo = new MutationObserver((records) => {
      if (records.some((r) => (r.target as HTMLElement).matches?.(".boards, .board-section, .board"))) watch();
    });
    mo.observe(grid, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  return ref;
}

/** The one input on the board. Each ask becomes its own matter. */
function Ask({ onStarted, setNote }: { onStarted: () => void; setNote: (s: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const { thread } = await api.post<{ thread: Thread }>("/api/threads", { text: t });
      setText("");
      setNote(`On it. “${thread.title === "New thread" ? t.slice(0, 60) : thread.title}” is on your board.`);
      onStarted();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ask" onSubmit={(e) => void submit(e)}>
      <textarea
        aria-label="Ask Vireo"
        placeholder="What should I take care of?"
        rows={1}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        data-testid="ask-input"
      />
      <button type="submit" aria-label="Send" disabled={busy || !text.trim()} data-testid="ask-send">
        <ArrowUpIcon />
      </button>
    </form>
  );
}
