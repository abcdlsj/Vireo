import { Markdown } from "../../markdown";
import { Frame, hostOf } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../types";
import { isHttp } from "../util";

/** An answer has no box: the conclusion set large, the sources under it. */
export default defineCard({
  kind: "answer",
  render: ({ card, expanded }) => {
    const text = field(card, "text", "");
    const sources = field<{ title?: string; url?: string }[]>(card, "sources", []).filter((s) => isHttp(s.url));
    const [lead, ...rest] = text.split(/\n\s*\n/);
    return (
      <Frame card={card} expanded={expanded} tone="bare">
        <p className="c-asked">{card.title}</p>
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
            {sources.slice(0, expanded ? 20 : 2).map((s, i) => (
              <a key={i} href={s.url} target="_blank" rel="noreferrer" title={s.title}>
                {hostOf(s.url!)}
              </a>
            ))}
            {!expanded && sources.length > 2 ? <span>+{sources.length - 2}</span> : null}
          </p>
        ) : null}
      </Frame>
    );
  },
});
