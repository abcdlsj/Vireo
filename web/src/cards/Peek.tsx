import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, onEvent, type ThreadDetail } from "../api";
import { relTime } from "../format";
import { ArrowUpIcon, ArrowUpRightIcon, CheckIcon, CloseIcon } from "../icons";
import { Markdown } from "../markdown";
import { cardView } from "./registry";
import type { Card } from "./types";

/**
 * A card opened from the board: the card in full, what Vireo last said about
 * the matter, and a line to answer it, without leaving the board. The thread
 * is one tap away for the whole conversation.
 */
export function Peek({ card, onClose, refresh }: { card: Card; onClose: () => void; refresh: () => void }) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [closing, setClosing] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const threadId = card.threadId;

  const load = useCallback(async () => {
    try {
      setDetail(await api.get<ThreadDetail>(`/api/threads/${threadId}`));
    } catch {
      setDetail(null);
    }
  }, [threadId]);

  useEffect(() => {
    void load();
    return onEvent((e) => {
      if ("threadId" in e && (e.threadId === threadId || e.threadId === "*")) void load();
    });
  }, [load, threadId]);

  const close = useCallback(() => {
    setClosing(true);
    window.setTimeout(onClose, 160);
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheet.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [close]);

  const view = cardView(card.kind);
  const thread = detail?.thread;
  const running = thread?.running ?? card.running;
  // A matter without a card of its own already shows its latest answer as the card.
  const latest =
    card.kind === "thread"
      ? undefined
      : detail?.messages
          .slice()
          .reverse()
          .find((m) => m.role === "assistant" && m.text.trim());
  const canClose = card.threadId !== "overview" && card.kind !== "reminder" && thread?.state !== "done";

  return (
    <div className={`peek ${closing ? "closing" : ""}`} data-testid="peek" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="peek-sheet" ref={sheet} tabIndex={-1} role="dialog" aria-modal="true" aria-label={card.title}>
        <header className="peek-head">
          {/* The card below carries the matter's name and status; the head only says when it last moved. */}
          <span className="peek-when">Updated {relTime(card.updatedAt)}</span>
          <span className="grow" />
          {canClose ? (
            <button
              className="peek-btn"
              onClick={() => void api.post(`/api/threads/${threadId}/done`).then(() => (refresh(), close()))}
              data-testid="peek-done"
            >
              <CheckIcon />
              Done
            </button>
          ) : null}
          <a className="peek-btn" href={`#thread/${threadId}`} data-testid="peek-open">
            Open thread
            <ArrowUpRightIcon />
          </a>
          <button className="peek-btn icon" onClick={close} aria-label="Close" data-testid="peek-close">
            <CloseIcon />
          </button>
        </header>
        <div className="peek-body">
          <div className="peek-card">
            {view.render({
              card: { ...card, running },
              expanded: true,
              refresh,
            })}
          </div>
          {running ? (
            <p className="peek-working" data-testid="peek-working">
              <span className="pulse-dot" />
              {thread?.statusLine || "Working on it…"}
            </p>
          ) : latest && latest.role === "assistant" ? (
            <div className="peek-latest">
              <span className="peek-latest-head">Vireo · {relTime(latest.createdAt)}</span>
              <Folded text={latest.text} />
            </div>
          ) : null}
        </div>
        <PeekReply threadId={threadId} done={thread?.state === "done"} onSent={load} />
      </div>
    </div>
  );
}

function PeekReply({ threadId, done, onSent }: { threadId: string; done: boolean; onSent: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/threads/${threadId}/messages`, { text: t });
      setText("");
      onSent();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="peek-reply" onSubmit={(e) => void submit(e)}>
      <input
        aria-label="Reply about this"
        placeholder={done ? "Message to reopen this matter" : "Reply about this…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        data-testid="peek-input"
      />
      <button type="submit" aria-label="Send" disabled={busy || !text.trim()} data-testid="peek-send">
        <ArrowUpIcon />
      </button>
    </form>
  );
}

/** Vireo's latest reply, folded to a few lines: the card above already carries the facts. */
function Folded({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 2);
  }, [text]);
  return (
    <>
      <div ref={ref} className={`peek-latest-text ${open ? "open" : long ? "folded" : ""}`}>
        <Markdown text={text} />
      </div>
      {long || open ? (
        <button className="peek-more" onClick={() => setOpen(!open)} data-testid="peek-more">
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}
