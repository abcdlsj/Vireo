import { api } from "../../api";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { clock, parseDate, until } from "../util";

/**
 * Minimal horology reminder object: quiet armed indicator, oversized crisp clock
 * numerals, botanical countdown, and clean hairline footer.
 */
export default defineCard({
  kind: "reminder",
  render: ({ card, expanded, refresh }) => {
    const due = parseDate(card.data.due);
    const today = due && due.toDateString() === new Date().toDateString();
    const countdown = due ? until(due) : "";
    const shortDate = due ? due.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
    const dateLine = due
      ? today
        ? `Today · ${shortDate}`
        : due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
      : "";
    const hasCancel = Boolean(card.data.reminderId);
    return (
      <Frame card={card} expanded={expanded} tone="paper" label={null} buttons={null} className="reminder">
        <div className="reminder-top">
          <span className="reminder-kicker">
            <span className="reminder-led" aria-hidden="true" />
            <span>Reminder</span>
          </span>
          {dateLine ? <span className="reminder-date">{dateLine}</span> : null}
        </div>
        <div className="reminder-when">
          <span className="reminder-time">{due ? clock(due) : "—"}</span>
          {countdown ? <span className="reminder-pill">{countdown}</span> : null}
        </div>
        <p className="reminder-text">{card.title}</p>
        {hasCancel ? (
          <div className="reminder-foot">
            <button
              type="button"
              className="reminder-cancel"
              onClick={(e) => {
                e.stopPropagation();
                void api.post(`/api/reminders/${String(card.data.reminderId)}/cancel`).then(refresh);
              }}
            >
              Cancel
            </button>
          </div>
        ) : null}
      </Frame>
    );
  },
});
