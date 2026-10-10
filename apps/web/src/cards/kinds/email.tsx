import type { ReactNode } from "react";
import { relTime } from "../../format";
import { Avatar, Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../util";
import { parseDate } from "../util";

/** A letter on the left, Vireo's reply on the right. Proposals to send an email reuse it. */
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
          <Avatar name={from} size={30} />
          <div>
            <span className="c-row-title">{from}</span>
            <span className="c-row-text">{[address, at ? relTime(at.getTime()) : ""].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
        <span className="mail-subject">{subject}</span>
        <p className="mail-body">{body}</p>
      </div>
      {draft ? (
        <div className="mail-draft">
          <span className="stub-label">{draftLabel}</span>
          <p className="mail-body">{draft}</p>
        </div>
      ) : null}
    </div>
  );
}

export default defineCard({
  kind: "email",
  wide: true,
  render: ({ card, expanded }) => (
    <Frame card={card} expanded={expanded}>
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
