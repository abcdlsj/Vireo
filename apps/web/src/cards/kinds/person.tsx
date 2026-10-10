import { Avatar, Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../types";

/** Someone the owner deals with, and what Vireo remembers about them. */
export default defineCard({
  kind: "person",
  render: ({ card, expanded }) => {
    const name = field(card, "name", card.title);
    const facts = field<string[]>(card, "facts", []);
    const email = field(card, "email", "");
    return (
      <Frame card={card} expanded={expanded}>
        <div className="person">
          <Avatar name={name} size={52} />
          <div>
            <h3 className="c-title">{name}</h3>
            <p className="c-sub">{[field(card, "role", ""), email].filter(Boolean).join(" · ")}</p>
          </div>
        </div>
        {facts.length ? (
          <ul className="facts">
            {facts.slice(0, expanded ? 30 : 3).map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        ) : null}
      </Frame>
    );
  },
});
