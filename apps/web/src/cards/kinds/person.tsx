import { Avatar, Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../util";

/** Editorial contact dossier: soft tinted masthead with ringed monogram avatar and remembered facts. */
export default defineCard({
  kind: "person",
  render: ({ card, expanded }) => {
    const name = field(card, "name", card.title);
    const facts = field<string[]>(card, "facts", []);
    const role = field(card, "role", "");
    const email = field(card, "email", "");
    return (
      <Frame card={card} expanded={expanded} className="person-card">
        <div className="person">
          <Avatar name={name} size={58} />
          <div className="person-meta">
            <h3 className="c-title">{name}</h3>
            {role ? <p className="person-role">{role}</p> : null}
            {email ? <p className="person-email">{email}</p> : null}
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
