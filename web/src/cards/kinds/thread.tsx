import { useEffect, useState } from "react";
import { authedUrl } from "../../hosts";
import { Markdown } from "../../markdown";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../types";

/**
 * A matter that hasn't shown a card yet: its latest answer. While the agent
 * works in the browser, it becomes a dark card with the live page in it.
 */
export default defineCard({
  kind: "thread",
  render: ({ card, expanded }) => {
    const text = field(card, "text", "");
    const statusLine = field(card, "statusLine", "");
    if (card.data.browsing && card.running) {
      return (
        <Frame card={card} expanded={expanded} tone="dark" label={<span className="live-dot">Working on the web</span>}>
          <LiveFrame threadId={card.threadId} />
          <h3 className="c-title">{statusLine || card.title}</h3>
        </Frame>
      );
    }
    return (
      <Frame card={card} expanded={expanded} label={null}>
        <h3 className="c-title">{card.title}</h3>
        {card.running && !text ? (
          <p className="c-sub working-line">{statusLine || "Working on it…"}</p>
        ) : !text && !statusLine ? (
          <p className="c-sub">Nothing here yet.</p>
        ) : (
          <div className="c-text fade">
            <Markdown text={text || statusLine} />
          </div>
        )}
        <ThreadStatus status={card.status} running={card.running} />
      </Frame>
    );
  },
});

function ThreadStatus({ status, running }: { status: string; running: boolean }) {
  if (running) return <span className="card-status working corner">Working</span>;
  if (status === "needs_you") return <span className="card-status needs corner">Needs you</span>;
  if (status === "done") return <span className="card-status done corner">Done</span>;
  return null;
}

/** The thread's browser page, refreshed every couple of seconds. */
function LiveFrame({ threadId }: { threadId: string }) {
  const [tick, setTick] = useState(0);
  const [ok, setOk] = useState(true);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 2000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="live-frame">
      {ok ? (
        <img src={authedUrl(`/api/threads/${threadId}/browser?t=${tick}`)} alt="The page Vireo is working on" onError={() => setOk(false)} onLoad={() => setOk(true)} />
      ) : (
        <span>Live view</span>
      )}
    </div>
  );
}
