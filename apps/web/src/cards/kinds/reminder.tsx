import { api } from "../../api";
import { BellIcon } from "../../icons";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { clock, parseDate, until } from "../util";

/**
 * A scheduled reminder: sunlit parchment gradient, monumental Braun-inspired
 * clock display with a countdown pill, and crisp editorial reminder text.
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
            <span className="reminder-day">
              {today ? `Today · ${until(due)}` : due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            </span>
          ) : null}
        </div>
        <p className="reminder-text fit" data-lines={2}>
          {card.title}
        </p>
      </Frame>
    );
  },
});
