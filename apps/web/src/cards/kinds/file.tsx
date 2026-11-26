import { extOf, fileKind, FileInlineStage, KIND_LABEL, openFilePreview } from "../../components/Attachments";
import { EyeIcon } from "../../icons";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../util";

/**
 * Curated Gallery Print file card: top live visual preview window (thumbnail,
 * miniature HTML page, CSV table, or document excerpt) paired with a crisp
 * museum caption bar. Clicking previews in-app instead of forcing download.
 */
export default defineCard({
  kind: "file",
  render: ({ card, expanded }) => {
    const name = field(card, "name", card.title);
    const fileId = field(card, "file_id", "");
    const mime = field(card, "mime", "");
    const meta = field(card, "meta", "");
    const fields = field<{ label?: string; value?: string }[]>(card, "fields", []);
    const ext = (extOf(name) || "file").toUpperCase();
    const kind = fileKind({ name, mime });

    const preview = () => {
      if (!fileId) return;
      openFilePreview({ fileId, name, mime });
    };

    return (
      <Frame card={card} expanded={expanded} flush label={null} className="file-card">
        <div
          className={`file-card-stage-hit ${fileId ? "clickable" : ""}`}
          onClick={(e) => {
            if (!fileId) return;
            e.stopPropagation();
            preview();
          }}
          role={fileId ? "button" : undefined}
          tabIndex={fileId ? 0 : undefined}
          onKeyDown={(e) => {
            if (fileId && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              e.stopPropagation();
              preview();
            }
          }}
          aria-label={fileId ? `Preview ${name}` : undefined}
        >
          <FileInlineStage fileId={fileId} name={name} mime={mime} />
        </div>
        <div className="file-card-foot">
          <div className="file-card-caption">
            <div className="file-card-meta-col">
              <h3 className="c-title">
                {fileId ? (
                  <button
                    type="button"
                    className="file-name-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      preview();
                    }}
                  >
                    {name}
                  </button>
                ) : (
                  name
                )}
              </h3>
              <p className="c-sub">{meta || KIND_LABEL[kind]}</p>
            </div>
            <div className="file-card-badges">
              <span className={`attach-ext-pill ext-${ext.toLowerCase()}`}>{ext.slice(0, 4)}</span>
              {fileId ? (
                <button
                  type="button"
                  className="file-preview-pill"
                  onClick={(e) => {
                    e.stopPropagation();
                    preview();
                  }}
                  title={`Preview ${name}`}
                >
                  <EyeIcon />
                  <span>Preview</span>
                </button>
              ) : null}
            </div>
          </div>
          {fields.length ? (
            <dl className="kv">
              {fields.slice(0, expanded ? 30 : 3).map((f, i) => (
                <div key={i}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </Frame>
    );
  },
});
