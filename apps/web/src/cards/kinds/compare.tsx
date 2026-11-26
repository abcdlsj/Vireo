import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { field, isHttp } from "../util";

interface Option {
  title?: string;
  subtitle?: string;
  value?: string;
  badge?: string;
  url?: string;
}

/**
 * Curated decision matrix: 2-3 options lay out as a side-by-side editorial
 * comparison podium (instant scannability, zero wasted width); 4+ options
 * switch to a sleek ranked list.
 */
export default defineCard({
  kind: "compare",
  size: "l",
  render: ({ card, expanded }) => {
    const options = field<Option[]>(card, "options", []);
    const subtitle = field(card, "subtitle", "");
    const note = field(card, "note", "");
    const shown = options.slice(0, expanded ? 12 : 3);
    const cols = shown.length >= 2 && shown.length <= 3;
    return (
      <Frame card={card} expanded={expanded} className={`compare-card ${cols ? "is-cols" : ""}`}>
        <div className="g-head">
          <h3 className="c-title">{card.title}</h3>
          {subtitle ? <p className="c-sub">{subtitle}</p> : null}
        </div>
        <ol className={`options ${cols ? "cols" : ""}`}>
          {shown.map((o, i) => (
            <li key={i} className={o.badge ? "picked" : ""}>
              {cols ? (
                <>
                  <div className="option-col-head">
                    <span className="option-rank">{String(i + 1).padStart(2, "0")}</span>
                    {o.badge ? <span className="badge">{o.badge}</span> : null}
                  </div>
                  <div className="option-text">
                    <span className="option-title">
                      {isHttp(o.url) ? (
                        <a href={o.url} target="_blank" rel="noreferrer">
                          {o.title}
                        </a>
                      ) : (
                        o.title
                      )}
                    </span>
                    {o.subtitle ? <span className="option-sub">{o.subtitle}</span> : null}
                  </div>
                  {o.value ? <span className="option-value">{o.value}</span> : null}
                </>
              ) : (
                <>
                  <span className="option-rank">{String(i + 1).padStart(2, "0")}</span>
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
                </>
              )}
            </li>
          ))}
        </ol>
        {!expanded && options.length > 3 ? <p className="c-more">{options.length - 3} more</p> : null}
        {note && expanded ? <p className="c-sub">{note}</p> : null}
      </Frame>
    );
  },
});
