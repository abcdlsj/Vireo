import type { ReactNode } from "react";
import { Avatar, Frame } from "../Frame";
import { defineCard } from "../registry";
import type { Card } from "../types";
import { field } from "../types";
import { clock, monthShort, parseDate, span, weekday } from "../util";

/** A tear-off calendar page beside the time, people and place. Proposals for invites reuse it. */
export function EventBody({
  card,
  title,
  start,
  end,
  location,
  attendees,
  note,
}: {
  card: Card;
  title: string;
  start: unknown;
  end?: unknown;
  location?: string;
  attendees?: string[];
  note?: string;
}): ReactNode {
  const s = parseDate(start);
  const e = parseDate(end);
  const people = attendees ?? [];
  return (
    <div className="tearoff-wrap">
      <div className={`tearoff ${card.status}`}>
        <span className="tearoff-month">{s ? `${weekday(s)} · ${monthShort(s)}`.toUpperCase() : ""}</span>
        <span className="tearoff-day">{s ? s.getDate() : "?"}</span>
      </div>
      <div className="event-main">
        <div className="event-time">
          <span className="event-clock">{s ? clock(s) : String(start ?? "")}</span>
          <span className="event-title">{title}</span>
        </div>
        <p className="c-sub">{[s && e ? span(s, e) : "", location].filter(Boolean).join(" · ")}</p>
        {people.length ? (
          <div className="people">
            <span className="c-stack">
              {people.slice(0, 4).map((p) => (
                <Avatar key={p} name={p} size={26} />
              ))}
            </span>
            <span className="c-sub">{people.length === 1 ? people[0] : `${people[0]} and ${people.length - 1} more`}</span>
          </div>
        ) : null}
        {note ? <p className="c-sub clamp">{note}</p> : null}
      </div>
    </div>
  );
}

export default defineCard({
  kind: "event",
  wide: true,
  render: ({ card, expanded }) => (
    <Frame card={card} expanded={expanded} flush>
      <EventBody
        card={card}
        title={card.title}
        start={card.data.start}
        end={card.data.end}
        location={field(card, "location", "")}
        attendees={field<string[]>(card, "attendees", [])}
        note={field(card, "note", "")}
      />
    </Frame>
  ),
});
