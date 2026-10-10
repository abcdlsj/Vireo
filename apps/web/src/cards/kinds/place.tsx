import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../types";
import { isHttp } from "../util";

/** A place: a drawn map tile with a pin, then name, address and when. */
export default defineCard({
  kind: "place",
  render: ({ card, expanded }) => {
    const url = field(card, "url", "");
    const name = field(card, "name", card.title);
    return (
      <Frame card={card} expanded={expanded} flush className="place">
        <div className="map" aria-hidden="true">
          <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 300 110">
            <path d="M0 70 C60 60 90 90 150 72 S250 40 300 52" />
            <path d="M40 0 L70 110" />
            <path d="M210 0 C200 40 230 70 220 110" />
          </svg>
          <span className="pin" />
          {field(card, "distance", "") ? <span className="map-chip">{field(card, "distance", "")}</span> : null}
        </div>
        <div className="place-text">
          <h3 className="c-title">
            {isHttp(url) ? (
              <a href={url} target="_blank" rel="noreferrer">
                {name}
              </a>
            ) : (
              name
            )}
          </h3>
          <p className="c-sub">{field(card, "address", "")}</p>
          {field(card, "when", "") ? <p className="place-when">{field(card, "when", "")}</p> : null}
          {field(card, "note", "") ? <p className="c-sub clamp">{field(card, "note", "")}</p> : null}
        </div>
      </Frame>
    );
  },
});
