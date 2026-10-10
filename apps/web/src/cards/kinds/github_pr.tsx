import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../types";
import { isHttp } from "../util";

const STATE_LABEL: Record<string, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };

/** A pull request: number, state, the size of the change and how its checks stand. */
export default defineCard({
  kind: "github_pr",
  render: ({ card, expanded }) => {
    const repo = field(card, "repo", "");
    const number = field(card, "number", 0);
    const url = field(card, "url", "");
    const state = field(card, "state", "open");
    const add = field(card, "additions", -1);
    const del = field(card, "deletions", -1);
    const files = field(card, "files", -1);
    const checks = field<{ passed?: number; total?: number } | null>(card, "checks", null);
    const review = field(card, "review", "");
    const total = checks?.total ?? 0;
    const passed = Math.min(total, checks?.passed ?? 0);
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
                {repo} #{number}
              </a>
            ) : (
              `${repo} #${number}`
            )}
          </span>
        }
      >
        <span className={`gh-state ${state}`}>{STATE_LABEL[state] ?? state}</span>
        <h3 className="c-title">{card.title}</h3>
        {add >= 0 || del >= 0 ? (
          <p className="gh-diff">
            {add >= 0 ? <span className="plus">+{add}</span> : null}
            {del >= 0 ? <span className="minus">−{del}</span> : null}
            {files >= 0 ? <span>{files} files</span> : null}
          </p>
        ) : null}
        {total ? (
          <div className="gh-checks" aria-label={`${passed} of ${total} checks passed`}>
            <div className="checks-bar">
              {Array.from({ length: Math.min(total, 24) }, (_, i) => (
                <span key={i} className={i < Math.round((passed / total) * Math.min(total, 24)) ? "pass" : "fail"} />
              ))}
            </div>
            <span className="c-sub">
              {passed === total ? "All checks passed" : `${total - passed} of ${total} checks failing`}
            </span>
          </div>
        ) : null}
        {review ? <p className="c-sub">{review}</p> : null}
      </Frame>
    );
  },
});

export function GitHubMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
