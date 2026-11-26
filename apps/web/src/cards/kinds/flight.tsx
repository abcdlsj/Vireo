import { Frame, Sparkline } from "../Frame";
import { defineCard } from "../registry";
import { dayLabel, field } from "../util";

/**
 * Curated architectural boarding pass poster: monumental IATA route, whisper-light
 * dotted flight arc, and crisp hairline telemetry footer (zero faux barcode clutter).
 */
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
      <Frame card={card} expanded={expanded} label={null} className={`pass ${booked ? "booked" : ""}`}>
        <div className="pass-top">
          <div className="pass-airline">
            {airline ? <b className="pass-carrier">{airline}</b> : null}
            {flight ? <span className="pass-flight-no">{flight}</span> : null}
            {booked ? <span className="pass-state">{done ? "Flown" : "Confirmed"}</span> : <span className="pass-state quiet">{card.status === "watching" ? "Watching fare" : "Best option"}</span>}
          </div>
          {booked?.seat ? <span className="pass-seat-pill">Seat {booked.seat}</span> : date ? <span className="pass-seat-pill">{date}</span> : null}
        </div>

        <div className="pass-route">
          <div className="pass-port">
            <span className="pass-code">{field(card, "from", "")}</span>
            <span className="pass-time">{field(card, "departs", "")}</span>
          </div>
          <div className="pass-arc">
            <div className="pass-arc-track" aria-hidden="true">
              <span className="pass-arc-dot start" />
              <svg className="pass-arc-svg" viewBox="0 0 180 24" preserveAspectRatio="none">
                <path d="M2,19 Q90,-3 178,19" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.5" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
              </svg>
              <span className="pass-arc-dot end" />
            </div>
            {duration ? <span className="pass-dur">{duration}</span> : null}
          </div>
          <div className="pass-port end">
            <span className="pass-code">{field(card, "to", "")}</span>
            <span className="pass-time">{field(card, "arrives", "")}</span>
          </div>
        </div>

        <div className="pass-foot">
          <div className="pass-meta">
            {date && booked?.seat ? <span>{date}</span> : null}
            {booked?.ref ? <span className="pass-ref">PNR {booked.ref}</span> : null}
            {details.slice(0, 3).map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </div>
          <div className="pass-price-wrap">
            {!booked && trend.length > 1 ? (
              <span className="accent-ink pass-spark">
                <Sparkline values={trend} width={86} height={24} />
              </span>
            ) : null}
            {price ? <span className="pass-price">{price}</span> : null}
          </div>
        </div>
      </Frame>
    );
  },
});
