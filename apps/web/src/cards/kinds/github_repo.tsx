import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../util";
import { isHttp } from "../util";
import { GitHubMark } from "./github_pr";

/** A repository's pulse: commits per day as bars, a few numbers, the newest event. */
export default defineCard({
  kind: "github_repo",
  render: ({ card, expanded }) => {
    const repo = field(card, "repo", "");
    const url = field(card, "url", "");
    const activity = field<number[]>(card, "activity", []).filter((n) => Number.isFinite(n));
    const stats = field<{ label?: string; value?: string }[]>(card, "stats", []);
    const latest = field(card, "latest", "");
    const max = Math.max(1, ...activity);
    return (
      <Frame
        card={card}
        expanded={expanded}
        className="gh"
        label={
          <span className="gh-repo">
            <GitHubMark />
            {isHttp(url) ? (
              <a href={url} target="_blank" rel="noreferrer">
                {repo}
              </a>
            ) : (
              repo
            )}
          </span>
        }
      >
        <h3 className="c-title">{card.title}</h3>
        {activity.length ? (
          <div className="bars" aria-label="Commits per day">
            {activity.slice(-28).map((n, i) => (
              <span key={i} style={{ height: `${Math.max(6, (n / max) * 100)}%` }} className={n ? "" : "zero"} />
            ))}
          </div>
        ) : null}
        {stats.length ? (
          <div className="stats stats-sm">
            {stats.slice(0, 3).map((s, i) => (
              <div key={i}>
                <span className="stat-value">{s.value}</span>
                <span className="stat-label">{s.label}</span>
              </div>
            ))}
          </div>
        ) : null}
        {latest ? <p className="c-sub clamp">{latest}</p> : null}
      </Frame>
    );
  },
});
