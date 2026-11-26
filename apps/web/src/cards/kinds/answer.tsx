import { Markdown } from "../../markdown";
import { Frame, hostOf } from "../Frame";
import { defineCard } from "../registry";
import { field, isHttp } from "../util";

/** An editorial insight card: the question as kicker, the conclusion set with magazine poise, citations as pills. */
export default defineCard({
  kind: "answer",
  render: ({ card, expanded }) => {
    const text = field(card, "text", "");
    const sources = field<{ title?: string; url?: string }[]>(card, "sources", []).filter((s) => isHttp(s.url));
    const [lead, ...rest] = text.split(/\n\s*\n/);
    return (
      <Frame card={card} expanded={expanded} className="answer-card">
        <div className="answer-kicker">
          <span className="answer-mark" aria-hidden="true" />
          <p className="c-asked">{card.title}</p>
        </div>
        <div className="answer-lead">
          <Markdown text={lead ?? ""} />
        </div>
        {rest.length ? (
          <div className="answer-rest">
            <Markdown text={rest.join("\n\n")} />
          </div>
        ) : null}
        {sources.length ? (
          <p className="c-sources">
            {sources.slice(0, expanded ? 20 : 3).map((s, i) => (
              <a key={i} href={s.url} target="_blank" rel="noreferrer" title={s.title}>
                <i className="src-dot" aria-hidden="true" />
                {hostOf(s.url!)}
              </a>
            ))}
            {!expanded && sources.length > 3 ? <span className="src-more">+{sources.length - 3}</span> : null}
          </p>
        ) : null}
      </Frame>
    );
  },
});
