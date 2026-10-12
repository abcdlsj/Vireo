import { useEffect, useState } from "react";
import { api } from "../api";
import { relTime } from "../format";
import { AlertIcon, CheckIcon, PointerIcon } from "../icons";
import { authedUrl } from "../nodes";

/**
 * Vireo's ask for the owner to do something in its browser (sign in, a
 * captcha, a passkey) as it sits in the conversation: the owner's turn, so it
 * reads like a confirmation does, not like a step folded away. Once settled it
 * shrinks to one line saying how it ended.
 */
export function BrowserAsk({
  threadId,
  request,
  state,
  since,
  onOpen,
}: {
  threadId: string;
  request: string;
  /** waiting while Vireo is paused on it; done, expired or stopped after. */
  state: string;
  since: number;
  onOpen: () => void;
}) {
  const ask = request.replace(/[.。!！]+$/, "");
  if (state === "done") {
    return (
      <div className="notice browser-ask-ended" data-testid="browser-ask-ended">
        <CheckIcon />
        <span>You handed the browser back · {ask}</span>
      </div>
    );
  }
  if (state !== "waiting") {
    return (
      <div className="notice browser-ask-ended" data-testid="browser-ask-ended">
        <AlertIcon />
        <span>{state === "expired" ? `Vireo took the browser back after 20 minutes · ${ask}` : `Stopped while waiting for you · ${ask}`}</span>
      </div>
    );
  }
  return (
    <div className="browser-ask" data-testid="browser-ask">
      <div className="browser-ask-head">
        <PointerIcon />
        <span>Your turn in the browser</span>
        <span className="when">{ago(since)}</span>
      </div>
      <div className="browser-ask-main">
        <div className="browser-ask-text">
          <p className="browser-ask-request" lang={/[\u3040-\u30ff\u3400-\u9fff]/.test(ask) ? "zh" : undefined}>
            {ask}
          </p>
          <p className="browser-ask-sub">Vireo is paused until you hand the browser back.</p>
        </div>
        <button className="browser-ask-thumb" onClick={onOpen} aria-label="Open the browser" tabIndex={-1}>
          <PageThumb threadId={threadId} />
        </button>
        <BrowserAskButtons threadId={threadId} onOpen={onOpen} />
      </div>
    </div>
  );
}

/** "just now", "3m ago": how long Vireo has been paused on the ask. */
export function ago(ms: number): string {
  const t = relTime(ms);
  return t === "now" ? "just now" : /\d$|[mhd]$/.test(t) ? `${t} ago` : t;
}

/** Open the browser to do it, or say it's done and give it back. */
export function BrowserAskButtons({ threadId, onOpen, card }: { threadId: string; onOpen: () => void; card?: boolean }) {
  const [busy, setBusy] = useState(false);
  const handBack = async () => {
    setBusy(true);
    try {
      await api.post(`/api/threads/${threadId}/browser/control`, { on: false });
    } finally {
      setBusy(false);
    }
  };
  const cls = card ? "cbtn" : "btn";
  return (
    <div className={card ? "vcard-buttons" : "browser-ask-buttons"}>
      <button className={`${cls} primary`} onClick={onOpen} data-testid="browser-request-open">
        Open browser
      </button>
      <button className={card ? `${cls} ghost` : cls} disabled={busy} onClick={() => void handBack()} data-testid="browser-request-done">
        Done, hand back
      </button>
    </div>
  );
}

/** The page as it is now, refreshed every couple of seconds while the ask is open. */
export function PageThumb({ threadId }: { threadId: string }) {
  const [tick, setTick] = useState(0);
  const [ok, setOk] = useState(true);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 2000);
    return () => window.clearInterval(t);
  }, []);
  return ok ? (
    <img src={authedUrl(`/api/threads/${threadId}/browser?t=${tick}`)} alt="The page Vireo opened for you" draggable={false} onError={() => setOk(false)} onLoad={() => setOk(true)} />
  ) : (
    <span className="muted">The page</span>
  );
}
