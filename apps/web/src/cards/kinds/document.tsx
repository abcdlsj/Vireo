import { openFilePreview } from "../../components/Attachments";
import { DocIcon, EyeIcon } from "../../icons";
import { Markdown } from "../../markdown";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../util";

/** Editorial manuscript object: calm paper typography with in-app file preview. */
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
              <button
                type="button"
                className="cbtn"
                onClick={(e) => {
                  e.stopPropagation();
                  openFilePreview({ fileId, name: card.title });
                }}
              >
                <EyeIcon />
                Preview file
              </button>
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
