import { fileUrl } from "../../api";
import { DocIcon } from "../../icons";
import { Markdown } from "../../markdown";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../util";

/** Something written to keep: a published manuscript page with editorial stationery polish. */
export default defineCard({
  kind: "document",
  render: ({ card, expanded }) => {
    const text = field(card, "text", "");
    const fileId = field(card, "file_id", "");
    return (
      <Frame
        card={card}
        expanded={expanded}
        className="doc"
        label={
          <span className="doc-kicker">
            <DocIcon />
            Document
          </span>
        }
        buttons={
          fileId && !card.buttons.length ? (
            <div className="vcard-buttons">
              <a className="cbtn" href={fileUrl(fileId)} target="_blank" rel="noreferrer">
                Open file
              </a>
            </div>
          ) : undefined
        }
      >
        <h3 className="c-title">{card.title}</h3>
        <div className="doc-text">
          <Markdown text={text} />
        </div>
      </Frame>
    );
  },
});
