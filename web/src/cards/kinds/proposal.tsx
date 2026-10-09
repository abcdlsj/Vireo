import { useState } from "react";
import { api } from "../../api";
import { prettyDates, toolLabel } from "../../format";
import { ToolIcon } from "../../icons";
import { go } from "../../route";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import type { Card } from "../types";
import { EmailBody } from "./email";
import { EventBody } from "./event";

/**
 * An outward action waiting for the owner. Drawn by our code from the action
 * itself (never by the model), so what the owner confirms is what will run.
 * Tools with a natural material reuse it: an invite is a calendar page, an
 * email is a letter.
 */
export default defineCard({
  kind: "proposal",
  wide: true,
  render: ({ card, expanded, refresh }) => (
    <Frame card={card} expanded={expanded} flush={card.data.tool === "create_event"} buttons={<Decide card={card} refresh={refresh} />}>
      <ProposalBody card={card} />
    </Frame>
  ),
});

function ProposalBody({ card }: { card: Card }) {
  const tool = String(card.data.tool ?? "");
  const args = (card.data.args ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  if (tool === "create_event") {
    return (
      <EventBody
        card={card}
        title={str("title")}
        start={args.start}
        end={args.end}
        location={str("location")}
        attendees={Array.isArray(args.attendees) ? args.attendees.map(String) : []}
        note={str("description")}
      />
    );
  }
  if (tool === "send_email") {
    return <EmailBody from={`To ${str("to")}`} subject={str("subject")} body={str("body")} address={str("cc") ? `cc ${str("cc")}` : ""} />;
  }
  return (
    <div className="proposal">
      <span className="proposal-kind">
        <ToolIcon tool={tool} />
        {toolLabel(tool)}
      </span>
      <p className="c-title">{prettyDates(card.title)}</p>
    </div>
  );
}

function Decide({ card, refresh }: { card: Card; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = String(card.data.actionId);
  const run = async (path: string) => {
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/actions/${id}/${path}`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div className="vcard-buttons">
      <button className="cbtn primary" disabled={busy} onClick={() => void run("confirm")} data-testid="card-confirm">
        {card.data.tool === "send_email" ? "Send" : card.data.tool === "create_event" ? "Send invite" : "Confirm"}
      </button>
      <button className="cbtn" disabled={busy} onClick={() => go(`thread/${card.threadId}`)}>
        Edit
      </button>
      <button className="cbtn ghost" disabled={busy} onClick={() => void run("cancel")} data-testid="card-cancel">
        Not now
      </button>
      {error ? <span className="vcard-error">{error}</span> : null}
    </div>
  );
}
