import { Frame, Sparkline } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../types";
import { dayLabel } from "../util";

/** A boarding pass: the route large, a perforation, and a stub with the price or the seat. */
export default defineCard({
  kind: "flight",
  wide: true,
  render: ({ card, expanded }) => {
    const booked = field<{ seat?: string; ref?: string } | null>(card, "booked", null);
    const price = field(card, "price", "");
    const trend = field<number[]>(card, "trend", []);
    const details = field<string[]>(card, "details", []);
    const airline = field(card, "airline", "");
    const flight = field(card, "flight", "");
    const done = card.status === "done";
    return (
      <Frame card={card} expanded={expanded} className={`pass ${booked ? "booked" : ""}`}>
        <div className="pass-main">
          <div className="pass-airline">
            {airline ? <b>{airline}</b> : null}
            <span>{[flight, card.title].filter(Boolean).join(" · ")}</span>
          </div>
          <div className="pass-route">
            <div>
              <span className="pass-code">{field(card, "from", "")}</span>
              <span className="pass-time">{field(card, "departs", "")}</span>
            </div>
            <div className="pass-path">
              <span className="dash" />
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M21 15.5v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V8.5l-8 5v2l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-5z" transform="rotate(90 12 12)" />
              </svg>
              <span className="dash" />
              <small>{field(card, "duration", "")}</small>
            </div>
            <div className="end">
              <span className="pass-code">{field(card, "to", "")}</span>
              <span className="pass-time">{field(card, "arrives", "")}</span>
            </div>
          </div>
          <div className="pass-details">
            <span>{dayLabel(field(card, "date", ""))}</span>
            {details.slice(0, 3).map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </div>
        </div>
        <div className="pass-stub">
          {booked ? (
            <>
              <span className="stub-label">{done ? "Flown" : "Booked"}</span>
              {booked.seat ? <span className="stub-big">{booked.seat}</span> : null}
              {booked.ref ? <span className="stub-ref">Ref {booked.ref}</span> : null}
            </>
          ) : (
            <>
              <span className="stub-label">{card.status === "watching" ? "Watching price" : "Best price"}</span>
              <span className="stub-big">{price || "—"}</span>
              <span className="accent-ink">
                <Sparkline values={trend} width={150} height={26} />
              </span>
            </>
          )}
        </div>
      </Frame>
    );
  },
});
