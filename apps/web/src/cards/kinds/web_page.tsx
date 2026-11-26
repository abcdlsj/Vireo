import { GlobeIcon } from "../../icons";
import { Frame, hostOf } from "../Frame";
import { defineCard } from "../registry";
import { field, isHttp } from "../util";

/** A curated web snapshot: refined mini-browser top bar with address pill and editorial excerpt. */
export default defineCard({
  kind: "web_page",
  render: ({ card, expanded }) => {
    const url = field(card, "url", "");
    const site = field(card, "site", "") || hostOf(url);
    return (
      <Frame card={card} expanded={expanded} className="webpage">
        <div className="chrome">
          <span className="chrome-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="chrome-pill">
            <GlobeIcon />
            {isHttp(url) ? (
              <a className="chrome-url" href={url} target="_blank" rel="noreferrer">
                {site}
              </a>
            ) : (
              <span className="chrome-url">{site}</span>
            )}
          </span>
        </div>
        <h3 className="c-title">{card.title}</h3>
        <p className="c-text clamp-4">{field(card, "summary", "")}</p>
      </Frame>
    );
  },
});
