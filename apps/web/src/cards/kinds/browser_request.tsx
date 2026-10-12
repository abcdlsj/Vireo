import { ago, BrowserAskButtons, PageThumb } from "../../components/BrowserAsk";
import { PointerIcon } from "../../icons";
import { go } from "../../route";
import { Frame } from "../Frame";
import { defineCard } from "../registry";

/**
 * Vireo is paused on something only the owner should do in its browser.
 * Drawn by our code from the ask itself; the board puts it under "Needs you".
 */
export default defineCard({
  kind: "browser_request",
  render: ({ card, expanded }) => {
    const since = Number(card.data.since ?? card.createdAt);
    return (
      <Frame
        card={card}
        expanded={expanded}
        tone="warm"
        className="browser-request-card"
        label={
          <span className="browser-request-label">
            <PointerIcon />
            Your turn in the browser
          </span>
        }
        buttons={<BrowserAskButtons card threadId={card.threadId} onOpen={() => go(`thread/${card.threadId}?browser`)} />}
      >
        <h3 className="c-title">{String(card.data.request ?? card.title).replace(/[.。!！]+$/, "")}</h3>
        <p className="c-sub">
          {card.threadTitle} · paused {ago(since)}
        </p>
        <div className="browser-request-thumb">
          <PageThumb threadId={card.threadId} />
        </div>
      </Frame>
    );
  },
});
