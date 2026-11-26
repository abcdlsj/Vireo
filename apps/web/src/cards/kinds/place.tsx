import { MapPinIcon } from "../../icons";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { field, isHttp } from "../util";

/** A city-guide location card: layered topographic map header with pulsing beacon, then editorial details. */
export default defineCard({
  kind: "place",
  render: ({ card, expanded }) => {
    const url = field(card, "url", "");
    const name = field(card, "name", card.title);
    const distance = field(card, "distance", "");
    const address = field(card, "address", "");
    const when = field(card, "when", "");
    const note = field(card, "note", "");
    return (
      <Frame card={card} expanded={expanded} flush className="place">
        <div className="map" aria-hidden="true">
          <svg width="100%" height="100%" preserveAspectRatio="xMidYMid slice" viewBox="0 0 320 132">
            {/* Parks & water contours */}
            <path className="map-water" d="M230 -10 C250 35 280 55 335 72 L335 -10 Z" />
            <rect className="map-park" x="18" y="14" width="66" height="44" rx="14" />
            <rect className="map-park" x="168" y="76" width="56" height="38" rx="12" />
            {/* Minor streets */}
            <path className="map-minor" d="M0 32 L320 18" />
            <path className="map-minor" d="M112 0 L132 132" />
            <path className="map-minor" d="M0 104 L260 94" />
            {/* Arterial roads */}
            <path className="map-road" d="M-10 78 C64 62 104 94 166 70 S264 36 330 48" />
            <path className="map-road" d="M46 -8 L78 140" />
            <path className="map-road" d="M222 -8 C206 46 238 82 224 140" />
          </svg>
          <span className="pin-beacon">
            <span className="pin-ring" />
            <span className="pin" />
          </span>
          {distance ? <span className="map-chip">{distance}</span> : null}
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
          {address ? (
            <p className="place-address">
              <MapPinIcon />
              <span>{address}</span>
            </p>
          ) : null}
          {when ? <p className="place-when">{when}</p> : null}
          {note ? <p className="c-sub clamp">{note}</p> : null}
        </div>
      </Frame>
    );
  },
});
