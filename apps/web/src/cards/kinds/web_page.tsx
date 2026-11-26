import { ArrowUpRightIcon, GlobeIcon } from "../../icons";
import { Frame, hostOf } from "../Frame";
import { defineCard } from "../registry";
import { field, isHttp } from "../util";

/** Minimalist web reading card: clean domain masthead and crisp editorial excerpt (no faux browser dots). */
export default defineCard({
  kind: "web_page",
  render: ({ card, expanded }) => {
    const url = field(card, "url", "");
    const site = field(card, "site", "") || hostOf(url);
    return (
      <Frame card={card} expanded={expanded} label={null} className="webpage">
        <div className="chrome">
          <span className="chrome-pill">
            <GlobeIcon />
            {isHttp(url) ? (
              <a className="chrome-url" href={url} target="_blank" rel="noreferrer">
                {site}
                <ArrowUpRightIcon />
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
