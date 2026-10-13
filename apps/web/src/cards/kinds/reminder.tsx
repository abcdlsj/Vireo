import { api } from "../../api";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { clock, parseDate, until } from "../util";

/** A scheduled reminder: warm paper, the time large with its day beside it, then what it is about. */
export default defineCard({
  kind: "reminder",
  render: ({ card, expanded, refresh }) => {
    const due = parseDate(card.data.due);
    const today = due && due.toDateString() === new Date().toDateString();
    return (
      <Frame
        card={card}
        expanded={expanded}
        tone="warm"
        className="reminder"
        label={<span className="bell">Reminder</span>}
        buttons={
          <div className="vcard-buttons">
            <button className="cbtn" onClick={() => void api.post(`/api/reminders/${String(card.data.reminderId)}/cancel`).then(refresh)}>
              Cancel
            </button>
          </div>
        }
      >
        <div className="reminder-when">
          <span className="reminder-time">{due ? clock(due) : ""}</span>
          <span className="reminder-day">{due ? (today ? `Today · ${until(due)}` : due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })) : ""}</span>
        </div>
        <p className="reminder-text fit" data-lines={3}>
          {card.title}
        </p>
      </Frame>
    );
  },
});
