import { api } from "../../api";
import { BellIcon } from "../../icons";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { clock, parseDate, until } from "../util";

/**
 * A scheduled reminder: Braun-inspired warm sunlit desk clock poster.
 * Monumental display time paired horizontally with a countdown pill & date
 * stack (no empty right void), over a crisp accent-lined reminder strip.
 */
export default defineCard({
  kind: "reminder",
  height: "medium",
  render: ({ card, expanded, refresh }) => {
    const due = parseDate(card.data.due);
    const today = due && due.toDateString() === new Date().toDateString();
    const cancel = card.data.reminderId ? (
      <button
        className="c-corner-act"
        onClick={(e) => {
          e.stopPropagation();
          void api.post(`/api/reminders/${String(card.data.reminderId)}/cancel`).then(refresh);
        }}
      >
        Cancel
      </button>
    ) : null;
    const countdown = due ? until(due) : "";
    const dateLine = due
      ? today
        ? "Today"
        : due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
      : "";
    return (
      <Frame
        card={card}
        expanded={expanded}
        tone="warm"
        className="reminder"
        label={
          <span className="bell">
            <BellIcon />
            Reminder
          </span>
        }
        buttons={null}
        corner={cancel}
      >
        <div className="reminder-when">
          <span className="reminder-time">{due ? clock(due) : ""}</span>
          {due ? (
            <div className="reminder-meta">
              {countdown ? <span className="reminder-day">{countdown}</span> : null}
              {dateLine ? <span className="reminder-date">{dateLine}</span> : null}
            </div>
          ) : null}
        </div>
        <p className="reminder-text fit" data-lines={2}>
          {card.title}
        </p>
      </Frame>
    );
  },
});
