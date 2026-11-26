import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { cachedThread, fetchThread, rememberThread } from "../thread-cache";
import { api, onEvent, type ThreadDetail } from "../api";
import { relTime } from "../format";
import { ArrowUpIcon, ArrowUpRightIcon, CheckIcon, CloseIcon, SharePosterIcon, StopIcon } from "../icons";
import { attentionOf, Eyes, nowLine } from "../components/Eyes";
import { Markdown, StreamingMarkdown } from "../markdown";
import { openCardShare } from "./CardShare";
import { cardView } from "./registry";
import type { Card } from "@vireo/protocol";

interface LivePeek {
  streamId: string;
  text: string;
  ended?: boolean;
}

/**
 * A card opened from the board: the card in full, what Vireo last said about
 * the matter, and a line to answer it, without leaving the board. The thread
 * is one tap away for the whole conversation.
 */
export function Peek({ card, onClose, refresh }: { card: Card; onClose: () => void; refresh: () => void }) {
  const [detail, setDetail] = useState<ThreadDetail | null>(() => cachedThread(card.threadId));
  const [live, setLive] = useState<LivePeek | null>(null);
  const [closing, setClosing] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const loadSeq = useRef(0);
  const reloadTimer = useRef<number | undefined>(undefined);
  const latestRef = useRef(detail);
  const threadId = card.threadId;

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const d = await fetchThread(threadId, latestRef.current);
      if (seq !== loadSeq.current) return;
      latestRef.current = d;
      setDetail(d);
      rememberThread(d);
      setLive((l) => {
        if (!l?.ended) return l;
        const text = l.text.trim();
        if (!text || !d.thread.running) return null;
        return d.messages.some((m) => m.role === "assistant" && m.text.trim() === text) ? null : l;
      });
    } catch {
      if (seq === loadSeq.current && !latestRef.current) setDetail(null);
    }
  }, [threadId]);

  useEffect(() => {
    void load();
    let pending: { streamId: string; text: string } | null = null;
    let frame = 0;
    const flush = () => {
      frame = 0;
      const p = pending;
      pending = null;
      if (p) setLive((l) => (l && l.streamId === p.streamId ? { ...l, text: l.text + p.text } : l));
    };
    const off = onEvent((e) => {
      if (!("threadId" in e) || (e.threadId !== threadId && e.threadId !== "*")) return;
      switch (e.type) {
        case "message.stream_start":
          flush();
          setLive({ streamId: e.streamId, text: "" });
          break;
        case "message.delta":
          if (e.kind !== "text") break;
          if (pending && pending.streamId !== e.streamId) flush();
          pending ??= { streamId: e.streamId, text: "" };
          pending.text += e.delta;
          frame ||= requestAnimationFrame(flush);
          break;
        case "message.stream_end":
          cancelAnimationFrame(frame);
          flush();
          setLive((l) => (l?.streamId === e.streamId ? { ...l, ended: true } : l));
          void load();
          break;
        default:
          window.clearTimeout(reloadTimer.current);
          reloadTimer.current = window.setTimeout(() => void load(), 120);
      }
    });
    return () => {
      off();
      cancelAnimationFrame(frame);
      window.clearTimeout(reloadTimer.current);
    };
  }, [load, threadId]);

  const close = useCallback(() => {
    setClosing(true);
    window.setTimeout(onClose, 160);
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheet.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Poster Studio sits above Peek; let it handle Escape first without closing Peek underneath.
      if (e.key === "Escape" && !document.querySelector('[data-testid="card-share"]')) close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [close]);

  const view = cardView(card.kind);
  // A card that is one column wide on the board opens as one column here too: a sheet its own size reads better than a wide one half filled.
  const narrow = (typeof view.size === "function" ? view.size(card) : view.size) !== "l";
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
  // A pending confirmation is the owner's turn even mid-reply; otherwise a run in progress is working.
  const attn = attentionOf({ running, needsYou: thread?.needsYou, pendingActions: thread?.pendingActions, status: card.status === "needs_you" ? card.status : undefined });
  const canClose = card.threadId !== "overview" && card.kind !== "reminder" && thread?.state !== "done";

  return (
    <div className={`peek ${closing ? "closing" : ""}`} data-testid="peek" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`peek-sheet ${narrow ? "narrow" : ""}`} ref={sheet} tabIndex={-1} role="dialog" aria-modal="true" aria-label={card.title}>
        <header className="peek-head">
          {/* The one place the peek says the matter's state: working (and on what), needs you, or when it last moved. */}
          <span className={`peek-when attn-line ${attn}`} data-testid={running ? "peek-working" : undefined}>
            {attn === "working" || attn === "needs" ? <Eyes state={attn} /> : null}
            <span className="attn-text">
              {attn === "working" ? nowLine(thread?.statusLine ?? card.statusLine) || "Working" : attn === "needs" ? "Needs you" : `Updated ${relTime(card.updatedAt)}`}
            </span>
          </span>
          <span className="grow" />
          <button
            className="peek-btn"
            onClick={() => openCardShare({ ...card, running })}
            title="Share as poster"
            data-testid="peek-share"
          >
            <SharePosterIcon />
            Poster
          </button>
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
          {live?.text ? (
            <div className="peek-latest" data-testid="peek-live">
              <span className="peek-latest-head">Vireo · writing…</span>
              <div className="peek-latest-text open">
                <StreamingMarkdown text={live.text} />
              </div>
            </div>
          ) : !running && latest && latest.role === "assistant" ? (
            <div className="peek-latest">
              <span className="peek-latest-head">Vireo · {relTime(latest.createdAt)}</span>
              <Folded text={latest.text} />
            </div>
          ) : null}
        </div>
        <PeekReply threadId={threadId} done={thread?.state === "done"} running={running} onSent={load} />
      </div>
    </div>
  );
}

function PeekReply({ threadId, done, running, onSent }: { threadId: string; done: boolean; running: boolean; onSent: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/threads/${threadId}/messages`, { text: t });
      setText("");
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="peek-reply-wrap">
      {error ? <p className="peek-reply-error" role="alert">{error}</p> : null}
      <form className="peek-reply" onSubmit={(e) => void submit(e)}>
        <input
          aria-label="Reply about this"
          placeholder={done ? "Message to reopen this matter" : "Reply about this…"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.nativeEvent.isComposing) e.preventDefault();
          }}
          data-testid="peek-input"
        />
        {running && !text.trim() ? (
          <button
            type="button"
            className="stop"
            aria-label="Stop"
            title="Stop"
            onClick={() => void api.post(`/api/threads/${threadId}/stop`).then(onSent, () => undefined)}
          >
            <StopIcon />
          </button>
        ) : (
          <button type="submit" aria-label="Send" disabled={busy || !text.trim()} data-testid="peek-send">
            <ArrowUpIcon />
          </button>
        )}
      </form>
    </div>
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
