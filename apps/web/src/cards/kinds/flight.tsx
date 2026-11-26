import { Frame, Sparkline } from "../Frame";
import { defineCard } from "../registry";
import { dayLabel, field } from "../util";

/** A Flighty-grade boarding pass: monumental IATA route, curved flight arc, perforated stub with barcode or live price curve. */
export default defineCard({
  kind: "flight",
  size: "l",
  render: ({ card, expanded }) => {
    const booked = field<{ seat?: string; ref?: string } | null>(card, "booked", null);
    const price = field(card, "price", "");
    const trend = field<number[]>(card, "trend", []);
    const details = field<string[]>(card, "details", []);
    const airline = field(card, "airline", "");
    const flight = field(card, "flight", "");
    const date = dayLabel(field(card, "date", ""));
    const duration = field(card, "duration", "");
    const done = card.status === "done";
    return (
      <Frame card={card} expanded={expanded} className={`pass ${booked ? "booked" : ""}`}>
        <div className="pass-main">
          <div className="pass-airline">
            {airline ? <b className="pass-carrier">{airline}</b> : null}
            {flight ? <span className="pass-flight-no">{flight}</span> : null}
            {card.title ? <span className="pass-route-note">{card.title}</span> : null}
          </div>
          <div className="pass-route">
            <div className="pass-port">
              <span className="pass-code">{field(card, "from", "")}</span>
              <span className="pass-time">{field(card, "departs", "")}</span>
            </div>
            <div className="pass-path">
              <span className="pass-dot" aria-hidden="true" />
              <span className="dash" />
              <span className="pass-plane" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M21 15.5v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V8.5l-8 5v2l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-5z" transform="rotate(90 12 12)" />
                </svg>
              </span>
              <span className="dash" />
              <span className="pass-dot end" aria-hidden="true" />
              {duration ? <small>{duration}</small> : null}
            </div>
            <div className="pass-port end">
              <span className="pass-code">{field(card, "to", "")}</span>
              <span className="pass-time">{field(card, "arrives", "")}</span>
            </div>
          </div>
          <div className="pass-details">
            {date ? <span className="pass-pill">{date}</span> : null}
            {details.slice(0, 3).map((d, i) => (
              <span key={i} className="pass-detail-item">
                {d}
              </span>
            ))}
          </div>
        </div>
        <div className="pass-stub">
          {booked ? (
            <>
              <span className="stub-seal">{done ? "Flown" : "Confirmed"}</span>
              <div className="stub-seat-block">
                <span className="stub-caption">Seat</span>
                <span className="stub-big">{booked.seat || "—"}</span>
              </div>
              {booked.ref ? <span className="stub-ref">PNR · {booked.ref}</span> : null}
              <div className="pass-barcode" aria-hidden="true" />
            </>
          ) : (
            <>
              <span className="stub-label">{card.status === "watching" ? "Watching fare" : "Best fare"}</span>
              <span className="stub-big">{price || "—"}</span>
              {trend.length > 1 ? (
                <span className="accent-ink stub-spark">
                  <Sparkline values={trend} width={156} height={32} />
                </span>
              ) : null}
            </>
          )}
        </div>
      </Frame>
    );
  },
});
