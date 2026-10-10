import { fileUrl } from "../../api";
import { Frame } from "../Frame";
import { defineCard } from "../registry";
import { field } from "../types";

/** A file with a folded corner and the facts read out of it. */
export default defineCard({
  kind: "file",
  render: ({ card, expanded }) => {
    const name = field(card, "name", card.title);
    const fileId = field(card, "file_id", "");
    const fields = field<{ label?: string; value?: string }[]>(card, "fields", []);
    const ext = (name.match(/\.(\w{2,4})$/)?.[1] ?? "file").toUpperCase();
    return (
      <Frame card={card} expanded={expanded}>
        <div className="file-head">
          <span className={`sheet ext-${ext.toLowerCase()}`}>{ext}</span>
          <div>
            <h3 className="c-title">
              {fileId ? (
                <a href={fileUrl(fileId)} target="_blank" rel="noreferrer">
                  {name}
                </a>
              ) : (
                name
              )}
            </h3>
            <p className="c-sub">{field(card, "meta", "") || card.title}</p>
          </div>
        </div>
        {fields.length ? (
          <dl className="kv">
            {fields.slice(0, expanded ? 30 : 4).map((f, i) => (
              <div key={i}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </Frame>
    );
  },
});
