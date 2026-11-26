import type { ReactNode } from "react";
import { relTime } from "../../format";
import { SparkIcon } from "../../icons";
import { Avatar, Frame } from "../Frame";
import { defineCard } from "../registry";
import { field, parseDate } from "../util";

/**
 * Editorial correspondence card: unified full-width sender + subject masthead,
 * then balanced two-column reading panes (incoming message on the left,
 * Vireo's sage-tinted reply stationery aligned on the right).
 */
export function EmailBody({
  from,
  address,
  subject,
  received,
  body,
  draft,
  draftLabel = "Vireo's reply",
}: {
  from: string;
  address?: string;
  subject: string;
  received?: unknown;
  body: string;
  draft?: string;
  draftLabel?: string;
}): ReactNode {
  const at = parseDate(received);
  return (
    <div className={`mail ${draft ? "with-draft" : ""}`}>
      <div className="mail-head">
        <div className="mail-from">
          <Avatar name={from} size={36} />
          <div>
            <span className="mail-name">{from}</span>
            <span className="c-row-text">{[address, at ? relTime(at.getTime()) : ""].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
        <span className="mail-subject">{subject}</span>
      </div>
      <div className="mail-panes">
        <div className="mail-in">
          <p className="mail-body">{body}</p>
        </div>
        {draft ? (
          <div className="mail-draft">
            <span className="stub-label mail-draft-head">
              <SparkIcon />
              {draftLabel}
            </span>
            <p className="mail-body">{draft}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default defineCard({
  kind: "email",
  size: "l",
  render: ({ card, expanded }) => (
    <Frame card={card} expanded={expanded} label={null} className="email-card">
      <EmailBody
        from={field(card, "from", "")}
        address={field(card, "address", "")}
        subject={field(card, "subject", card.title)}
        received={card.data.received}
        body={field(card, "body", "")}
        draft={field(card, "draft", "")}
      />
    </Frame>
  ),
});
