import { api } from "../../api";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { clock, parseDate, until } from "../util";

/**
 * A scheduled reminder: Swiss precision alarm slip with a crisp porcelain
 * clock band, glowing armed indicator, and recessed note tray.
 */
export default defineCard({
  kind: "reminder",
  height: "medium",
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
      <Frame card={card} expanded={expanded} tone="paper" flush label={null} buttons={null} className="reminder">
        <div className="reminder-dial">
          <div className="reminder-kicker">
            <span className="reminder-led" aria-hidden="true" />
            <span>Reminder</span>
          </div>
          <div className="reminder-when">
            <span className="reminder-time">{due ? clock(due) : "—"}</span>
            {countdown ? <span className="reminder-pill">{countdown}</span> : null}
          </div>
        </div>
        <div className="reminder-note">
          <p className="reminder-text fit" data-lines={2}>
            {card.title}
          </p>
          {dateLine || hasCancel ? (
            <div className="reminder-foot">
              <span className="reminder-date">{dateLine}</span>
              {hasCancel ? (
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
              ) : null}
            </div>
          ) : null}
        </div>
      </Frame>
    );
  },
});
