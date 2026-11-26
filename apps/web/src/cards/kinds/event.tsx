import type { ReactNode } from "react";
import { MapPinIcon } from "../../icons";
import { Avatar, Frame } from "../Frame";
import { defineCard } from "../registry";
import type { Card } from "@vireo/protocol";
import { clock, field, monthShort, parseDate, span, weekday } from "../util";

/** A sculpted tear-off desk calendar page beside the time, people and place. Proposals for invites reuse it. */
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
  const dur = s && e ? span(s, e) : "";
  return (
    <div className="tearoff-wrap">
      <div className={`tearoff ${card.status}`}>
        <div className="tearoff-top">
          <span className="tearoff-rings" aria-hidden="true">
            <i />
            <i />
          </span>
          <span className="tearoff-month">{s ? monthShort(s) : ""}</span>
        </div>
        <div className="tearoff-body">
          <span className="tearoff-day">{s ? s.getDate() : "?"}</span>
          <span className="tearoff-wk">{s ? weekday(s) : ""}</span>
        </div>
      </div>
      <div className="event-main">
        <div className="event-time">
          <span className="event-clock">{s ? clock(s) : String(start ?? "")}</span>
          {dur ? <span className="event-dur">{dur}</span> : null}
        </div>
        <h3 className="event-title">{title}</h3>
        {location ? (
          <p className="event-loc">
            <MapPinIcon />
            <span>{location}</span>
          </p>
        ) : null}
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
  size: "l",
  render: ({ card, expanded }) => (
    <Frame card={card} expanded={expanded} flush className="event-card">
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
