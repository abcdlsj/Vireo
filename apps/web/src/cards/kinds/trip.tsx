import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../util";
import { dayLabel, parseDate } from "../util";

interface Leg {
  from?: string;
  to?: string;
  departs?: string;
  arrives?: string;
  date?: string;
  airline?: string;
  flight?: string;
  price?: string;
}

interface ReturnOption {
  date?: string;
  price?: string;
  flight?: string;
}

/** Reads the amount out of a price like "¥1,348" or "320 USD". */
const amount = (price?: string) => Number(String(price ?? "").replace(/[^\d.]/g, "")) || 0;

/**
 * A round trip: each chosen leg as a line of a ticket; while the return is
 * open, the cheapest return per date as bars, the cheapest one picked out.
 */
export default defineCard({
  kind: "trip",
  wide: true,
  render: ({ card, expanded }) => {
    const outbound = field<Leg | null>(card, "outbound", null);
    const back = field<Leg | null>(card, "return", null);
    const options = field<ReturnOption[]>(card, "return_options", []).filter((o) => o.date && o.price);
    const note = field(card, "note", "");
    const total = field(card, "total", "");
    return (
      <Frame card={card} expanded={expanded} className="trip">
        <div className="trip-head">
          <h3 className="c-title">{card.title}</h3>
          {total ? (
            <span className="trip-total">
              <small>Total</small>
              {total}
            </span>
          ) : null}
        </div>
        {outbound ? <LegRow leg={outbound} label="Out" /> : null}
        {back ? <LegRow leg={back} label="Back" /> : options.length ? <ReturnBars options={options} /> : null}
        {note && expanded ? <p className="c-sub">{note}</p> : null}
      </Frame>
    );
  },
});

function LegRow({ leg, label }: { leg: Leg; label: string }) {
  return (
    <div className="leg">
      <span className="leg-label">{label}</span>
      <span className="leg-date">{leg.date ? dayLabel(leg.date) : ""}</span>
      <span className="leg-route">
        <b>{leg.from}</b> {leg.departs}
        <span className="leg-arrow">→</span>
        <b>{leg.to}</b> {leg.arrives}
      </span>
      <span className="leg-flight">{[leg.airline, leg.flight].filter(Boolean).join(" ")}</span>
      <span className="leg-price">{leg.price}</span>
    </div>
  );
}

function ReturnBars({ options }: { options: ReturnOption[] }) {
  const prices = options.map((o) => amount(o.price));
  const max = Math.max(...prices, 1);
  const min = Math.min(...prices.filter((p) => p > 0));
  const best = options[prices.indexOf(min)];
  return (
    <div className="returns">
      <div className="returns-head">
        <span className="leg-label">Back</span>
        {best ? (
          <span className="returns-best">
            Cheapest <b>{dayLabel(best.date!)}</b> {best.flight ? <span>· {best.flight}</span> : null}
          </span>
        ) : null}
      </div>
      <div className="return-bars" role="list">
        {options.map((o, i) => {
          const d = parseDate(`${o.date}T12:00:00`);
          const cheapest = prices[i] === min;
          return (
            <div key={i} className={`return-bar ${cheapest ? "best" : ""}`} role="listitem" title={[d?.toLocaleDateString(undefined, { weekday: "long" }), o.flight].filter(Boolean).join(" · ")}>
              {/* The price sits on its bar, so a column reads as one figure. */}
              <span className="bar-track">
                <span className="return-price">{o.price}</span>
                <span className="bar" style={{ height: `${8 + (max > min ? ((prices[i]! - min) / (max - min)) * 28 : 0)}px` }} />
              </span>
              <span className="return-date">{d ? `${d.getMonth() + 1}/${d.getDate()}` : o.date}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
