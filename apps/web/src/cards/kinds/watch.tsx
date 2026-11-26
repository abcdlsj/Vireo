import { relTime } from "../../format";
import { Frame, Sparkline } from "../Frame";
import { defineCard } from "../registry";
import { field, parseDate } from "../util";

/** Editorial telemetry & price/status tracker: monumental display figure, silky gradient sparkline, or milestone bar. */
export default defineCard({
  kind: "watch",
  render: ({ card, expanded }) => {
    const value = field(card, "value", "");
    const detail = field(card, "detail", "");
    const trend = field<number[]>(card, "trend", []);
    const steps = field<string[]>(card, "steps", []);
    const current = Math.max(0, Math.min(steps.length - 1, field(card, "current", 0)));
    const checked = parseDate(card.data.checked_at);
    const phrase = value.length > 10;
    return (
      <Frame card={card} expanded={expanded} className="watch">
        <div className="watch-top">
          <h3 className="c-title">{card.title}</h3>
          {value ? <p className={`watch-value ${phrase ? "phrase" : ""}`}>{value}</p> : null}
          {detail ? <p className="c-sub watch-detail">{detail}</p> : null}
        </div>
        {trend.length > 1 ? (
          <div className="watch-trend accent-ink">
            <Sparkline values={trend} height={expanded ? 104 : 68} />
          </div>
        ) : null}
        {steps.length ? (
          <div className="stages">
            <div className="stage-line" style={{ ["--p" as string]: `${steps.length > 1 ? (current / (steps.length - 1)) * 100 : 0}%` }}>
              {steps.map((_, i) => (
                <span key={i} className={`stage-dot ${i < current ? "past" : i === current ? "now" : ""}`} />
              ))}
            </div>
            <div className="stage-labels">
              {steps.map((s, i) => (
                <span key={i} className={i === current ? "now" : ""}>
                  {s}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {checked ? (
          <p className="c-foot-note watch-checked">
            <span className="watch-live-dot" aria-hidden="true" />
            Checked {relTime(checked.getTime())}
          </p>
        ) : null}
      </Frame>
    );
  },
});
