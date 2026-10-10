import { Frame, hostOf } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../util";
import { isHttp } from "../util";

/** A page worth keeping: a small browser chrome with the address, and what matters on it. */
export default defineCard({
  kind: "web_page",
  render: ({ card, expanded }) => {
    const url = field(card, "url", "");
    const site = field(card, "site", "") || hostOf(url);
    return (
      <Frame card={card} expanded={expanded} className="webpage">
        <div className="chrome">
          <span className="chrome-dots">
            <i />
            <i />
            <i />
          </span>
          {isHttp(url) ? (
            <a className="chrome-url" href={url} target="_blank" rel="noreferrer">
              {site}
            </a>
          ) : (
            <span className="chrome-url">{site}</span>
          )}
        </div>
        <h3 className="c-title">{card.title}</h3>
        <p className="c-text clamp-4">{field(card, "summary", "")}</p>
      </Frame>
    );
  },
});
