import type { ReactNode } from "react";
import { relTime } from "../../format";
import { SparkIcon } from "../../icons";
import { Avatar, Frame } from "../Frame";
import { defineCard } from "../registry";
import { field, parseDate } from "../util";

/** Editorial correspondence card: letter masthead + incoming quote + Vireo's sage-tinted stationery draft. */
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
      <div className="mail-in">
        <div className="mail-from">
          <Avatar name={from} size={38} />
          <div>
            <span className="mail-name">{from}</span>
            <span className="c-row-text">{[address, at ? relTime(at.getTime()) : ""].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
        <span className="mail-subject">{subject}</span>
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
  );
}

export default defineCard({
  kind: "email",
  size: "l",
  render: ({ card, expanded }) => (
    <Frame card={card} expanded={expanded} className="email-card">
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
