import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, onEvent, type Me, type Thread } from "../api";
import { CardSlot } from "../cards/CardSlot";
import type { Card } from "../cards/types";
import { ArrowUpIcon, CheckIcon } from "../icons";
import { HostSwitcher } from "./Hosts";

const NUMBERS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/**
 * The home board: what needs the owner, what is in hand, what is being
 * watched, each matter as one card. Asking starts a new matter; its card
 * appears here while Vireo works on it.
 */
export function Home({ me, onSignedOut }: { me: Me | null; onSignedOut: () => void }) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [note, setNote] = useState("");
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
      if (e.type === "card.updated" || e.type === "thread.updated" || e.type === "thread.deleted" || e.type === "action.updated" || e.type === "message.stream_end") {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void load(), 150);
      }
    });
  }, [load]);

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
        <header className="home-bar">
          <a href="#" aria-label="Vireo home">
            <img src="/icon.svg" alt="" width={26} height={26} />
          </a>
          <HostSwitcher />
          <span className="grow" />
          <a className="nav" href="#threads" data-testid="nav-threads">
            History
          </a>
          <a className="nav" href="#memory">
            Memory
          </a>
          <a className="nav" href="#settings">
            Settings{me && !me.models.ready ? <span className="dot warn" title="No model configured" /> : null}
          </a>
        </header>

        <div className="home-hero">
          <div className="home-greet">
            <span className="date">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>
            <h1 data-testid="home-headline">{headline}</h1>
          </div>
          <Ask onStarted={load} setNote={setNote} />
        </div>
        {note ? <p className="ask-sent">{note}</p> : null}

        <div className="board" data-testid="board">
          {cards && active.length === 0 ? (
            <div className="board-empty">
              <b>All clear</b>
              <span>Ask for anything above. Each matter shows up here as a card while Vireo takes care of it.</span>
            </div>
          ) : null}
          {active.map((c) => (
            <CardSlot key={c.id} card={c} refresh={load} />
          ))}
        </div>

        {done.length ? (
          <div className="done-strip" data-testid="done-strip">
            <span className="label">Done lately</span>
            {done.slice(0, 12).map((c) => (
              <a key={c.id} className="done-chip" href={`#thread/${c.threadId}`} title={c.title}>
                <CheckIcon />
                {c.title}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
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
