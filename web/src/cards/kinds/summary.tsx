import { Avatar, Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../types";
import { isHttp } from "../util";

/** The outcome of a batch: a few numbers, then the items that matter. */
export default defineCard({
  kind: "summary",
  render: ({ card, expanded }) => {
    const subtitle = field(card, "subtitle", "");
    const stats = field<{ label?: string; value?: string; attention?: boolean }[]>(card, "stats", []);
    const items = field<{ title?: string; text?: string; url?: string }[]>(card, "items", []);
    const shown = items.slice(0, expanded ? 50 : 3);
    return (
      <Frame card={card} expanded={expanded}>
        <h3 className="c-title big">{card.title}</h3>
        {subtitle ? <p className="c-sub">{subtitle}</p> : null}
        {stats.length ? (
          <div className="stats">
            {stats.slice(0, 4).map((s, i) => (
              <div key={i} className={s.attention ? "attention" : ""}>
                <span className="stat-value">{s.value}</span>
                <span className="stat-label">{s.label}</span>
              </div>
            ))}
          </div>
        ) : null}
        {shown.length ? (
          <ul className="rows">
            {shown.map((it, i) => (
              <li key={i}>
                <Avatar name={it.title ?? "?"} size={28} />
                <div>
                  <span className="row-title">
                    {isHttp(it.url) ? (
                      <a href={it.url} target="_blank" rel="noreferrer">
                        {it.title}
                      </a>
                    ) : (
                      it.title
                    )}
                  </span>
                  {it.text ? <span className="row-text">{it.text}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {!expanded && items.length > shown.length ? <p className="c-more">{items.length - shown.length} more</p> : null}
      </Frame>
    );
  },
});
