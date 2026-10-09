import { relTime } from "../../format";
import { Frame, Sparkline } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../types";
import { parseDate } from "../util";

/** Something Vireo keeps checking: the value now, how it moved, or which stage it is at. */
export default defineCard({
  kind: "watch",
  render: ({ card, expanded }) => {
    const value = field(card, "value", "");
    const detail = field(card, "detail", "");
    const trend = field<number[]>(card, "trend", []);
    const steps = field<string[]>(card, "steps", []);
    const current = Math.max(0, Math.min(steps.length - 1, field(card, "current", 0)));
    const checked = parseDate(card.data.checked_at);
    return (
      <Frame card={card} expanded={expanded}>
        <div className="watch-head">
          <h3 className="c-title">{card.title}</h3>
          <span className="watch-value">{value}</span>
        </div>
        {detail ? <p className="c-sub">{detail}</p> : null}
        {trend.length > 1 ? (
          <div className="accent-ink">
            <Sparkline values={trend} height={40} />
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
        {checked ? <p className="c-foot-note">Checked {relTime(checked.getTime())}</p> : null}
      </Frame>
    );
  },
});
