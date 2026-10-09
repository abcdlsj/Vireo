import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../types";
import { isHttp } from "../util";

interface Option {
  title?: string;
  subtitle?: string;
  value?: string;
  badge?: string;
  url?: string;
}

/** Options side by side; the picked one (with a badge) leads. */
export default defineCard({
  kind: "compare",
  wide: true,
  render: ({ card, expanded }) => {
    const options = field<Option[]>(card, "options", []);
    const subtitle = field(card, "subtitle", "");
    const note = field(card, "note", "");
    return (
      <Frame card={card} expanded={expanded}>
        <h3 className="c-title">{card.title}</h3>
        {subtitle ? <p className="c-sub">{subtitle}</p> : null}
        <ol className="options">
          {options.slice(0, expanded ? 12 : 3).map((o, i) => (
            <li key={i} className={o.badge ? "picked" : ""}>
              <div className="option-text">
                <span className="option-title">
                  {isHttp(o.url) ? (
                    <a href={o.url} target="_blank" rel="noreferrer">
                      {o.title}
                    </a>
                  ) : (
                    o.title
                  )}
                  {o.badge ? <span className="badge">{o.badge}</span> : null}
                </span>
                {o.subtitle ? <span className="option-sub">{o.subtitle}</span> : null}
              </div>
              {o.value ? <span className="option-value">{o.value}</span> : null}
            </li>
          ))}
        </ol>
        {!expanded && options.length > 3 ? <p className="c-more">{options.length - 3} more</p> : null}
        {note && expanded ? <p className="c-sub">{note}</p> : null}
      </Frame>
    );
  },
});
