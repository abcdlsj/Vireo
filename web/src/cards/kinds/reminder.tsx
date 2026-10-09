import { api } from "../../api";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { clock, parseDate, until } from "../util";

/** A scheduled reminder: warm paper, the time large. */
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
        label={<span className="bell">Reminder</span>}
        buttons={
          <div className="card-buttons">
            <button className="cbtn ghost" onClick={() => void api.post(`/api/reminders/${String(card.data.reminderId)}/cancel`).then(refresh)}>
              Cancel
            </button>
          </div>
        }
      >
        <span className="reminder-time">{due ? clock(due) : ""}</span>
        <span className="c-sub">{due ? (today ? `Today · ${until(due)}` : due.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })) : ""}</span>
        <h3 className="c-title">{card.title}</h3>
      </Frame>
    );
  },
});
