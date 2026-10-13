import { useEffect, useState } from "react";
import { authedUrl } from "../../nodes";
import { Markdown } from "../../markdown";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../util";

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
        <Frame card={card} expanded={expanded} tone="dark" label={<span className="web-live">On the web</span>}>
          <LiveFrame threadId={card.threadId} />
          <h3 className="c-title">{card.title}</h3>
        </Frame>
      );
    }
    return (
      <Frame card={card} expanded={expanded} label={null}>
        <h3 className="c-title">{card.title}</h3>
        {/* While it runs, the frame's step line (eyes and what) is the only working mark. */}
        {card.running && !text ? null : !text && !statusLine ? (
          <p className="c-sub">Nothing here yet.</p>
        ) : (
          <div className="c-text fit">
            <Markdown text={text || statusLine} />
          </div>
        )}
        {card.status === "done" && !card.running ? <span className="vcard-status done corner">Done</span> : null}
      </Frame>
    );
  },
});

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
