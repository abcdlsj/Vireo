import { api } from "../../api";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { clock, parseDate, until } from "../util";

/**
 * A scheduled reminder: warm paper, the time large with its day beside it,
 * then what it is about. Every reminder is the same card, with Cancel
 * at the end of the time's line.
 */
export default defineCard({
  kind: "reminder",
  height: "medium",
  render: ({ card, expanded, refresh }) => {
    const due = parseDate(card.data.due);
    const today = due && due.toDateString() === new Date().toDateString();
    // Cancelling is the rare thing to do here, so it sits in the head's corner at the size of the head's own text.
    const cancel = card.data.reminderId ? (
      <button className="c-corner-act" onClick={(e) => {
        e.stopPropagation();
        void api.post(`/api/reminders/${String(card.data.reminderId)}/cancel`).then(refresh);
      }}>
        Cancel
      </button>
    ) : null;
    return (
      <Frame card={card} expanded={expanded} tone="warm" className="reminder" label={<span className="bell">Reminder</span>} buttons={null} corner={cancel}>
        <div className="reminder-when">
          <span className="reminder-time">{due ? clock(due) : ""}</span>
          <span className="reminder-day">{due ? (today ? `Today · ${until(due)}` : due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })) : ""}</span>
        </div>
        <p className="reminder-text fit" data-lines={2}>
          {card.title}
        </p>
      </Frame>
    );
  },
});
