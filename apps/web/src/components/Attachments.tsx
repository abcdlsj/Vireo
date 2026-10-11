import { useCallback, useEffect, useRef, useState } from "react";
import { api, fileUrl, type FileInfo } from "../api";
import { bytes } from "../format";
import { CloseIcon, DownloadIcon } from "../icons";
import { Markdown } from "../markdown";

type Kind = "image" | "pdf" | "html" | "markdown" | "table" | "text" | "document" | "other";

/** How a file is previewed, from its type and name. */
export function fileKind(f: { mime: string; name: string }): Kind {
  const ext = extOf(f.name);
  if (f.mime.startsWith("image/")) return "image";
  if (f.mime === "application/pdf" || ext === "pdf") return "pdf";
  if (f.mime === "text/html" || ext === "html" || ext === "htm") return "html";
  if (f.mime === "text/markdown" || ext === "md" || ext === "markdown") return "markdown";
  if (f.mime === "text/csv" || f.mime === "text/tab-separated-values" || ext === "csv" || ext === "tsv") return "table";
  if (ext === "docx") return "document";
  if (/^(text\/|application\/(json|xml|yaml|javascript))/.test(f.mime) || /^(txt|json|ya?ml|log|xml|ics|js|ts|py|go|rs|sh|sql|toml|ini|css)$/.test(ext)) return "text";
  return "other";
}

const PHONE = "(max-width: 760px)";

const extOf = (name: string) => name.match(/\.(\w{1,8})$/)?.[1]?.toLowerCase() ?? "";

const KIND_LABEL: Record<Kind, string> = {
  image: "Image",
  pdf: "PDF",
  html: "Page",
  markdown: "Document",
  table: "Table",
  text: "Text",
  document: "Document",
  other: "File",
};

/** A small paper tile with the file's extension, in the file card's colours. */
function Sheet({ name }: { name: string }) {
  const ext = extOf(name) || "file";
  return <span className={`attach-sheet ext-${ext}`}>{ext.slice(0, 4).toUpperCase()}</span>;
}

/**
 * Files on a message: the owner's uploads above their bubble, and what Vireo
 * made under its reply. Each opens in the viewer; images show as thumbnails.
 */
export function Attachments({ files, onOpen, produced }: { files: FileInfo[]; onOpen: (f: FileInfo) => void; produced?: boolean }) {
  if (!files.length) return null;
  return (
    <div className={`attachments ${produced ? "produced" : ""}`} data-testid={produced ? "produced-files" : "attachments"}>
      {files.map((f) =>
        fileKind(f) === "image" && !produced ? (
          <button key={f.id} className="attach-image" onClick={() => onOpen(f)} aria-label={`Open ${f.name}`}>
            <img src={fileUrl(f.id)} alt={f.name} />
          </button>
        ) : (
          <button key={f.id} className="attach" onClick={() => onOpen(f)} data-testid="attachment" title={f.name}>
            {fileKind(f) === "image" ? <img className="attach-thumb" src={fileUrl(f.id)} alt="" /> : <Sheet name={f.name} />}
            <span className="attach-text">
              <span className="attach-name">{f.name}</span>
              <span className="attach-meta">
                {KIND_LABEL[fileKind(f)]} · {bytes(f.size)}
              </span>
            </span>
          </button>
        ),
      )}
    </div>
  );
}

/** A file waiting in the composer, before it is sent. */
export function PendingFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [thumb, setThumb] = useState("");
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <span className="attach pending" title={file.name}>
      {thumb ? <img className="attach-thumb" src={thumb} alt="" /> : <Sheet name={file.name} />}
      <span className="attach-text">
        <span className="attach-name">{file.name}</span>
        <span className="attach-meta">{bytes(file.size)}</span>
      </span>
      <button className="attach-remove" onClick={onRemove} aria-label={`Remove ${file.name}`}>
        <CloseIcon />
      </button>
    </span>
  );
}

type Content = { text: string } | { url: string } | { error: string } | null;

/**
 * A file opened in place: documents rendered, tables as tables, pages live in
 * a sandbox, PDFs in the browser's own viewer. Anything else can be downloaded.
 */
export function FileViewer({ file, onClose }: { file: FileInfo; onClose: () => void }) {
  const kind = fileKind(file);
  const [content, setContent] = useState<Content>(null);
  const [closing, setClosing] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setClosing(true);
    window.setTimeout(onClose, 160);
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheet.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [close]);

  useEffect(() => {
    let revoke = "";
    let gone = false;
    setContent(null);
    const load = async (): Promise<Content> => {
      if (kind === "image" || kind === "other") return null;
      // Phone browsers don't show PDFs inside a page, so there the viewer shows the text Vireo reads from it.
      if (kind === "document" || (kind === "pdf" && window.matchMedia(PHONE).matches)) return { text: (await api.get<{ text: string }>(`/api/files/${file.id}/text`)).text };
      const res = await fetch(fileUrl(file.id));
      if (!res.ok) throw new Error(res.statusText);
      if (kind === "pdf") {
        // Through a local copy, so the browser's PDF viewer shows it instead of downloading it.
        revoke = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: "application/pdf" }));
        return { url: revoke };
      }
      return { text: await res.text() };
    };
    load()
      .then((c) => !gone && setContent(c))
      .catch((err) => !gone && setContent({ error: err instanceof Error ? err.message : String(err) }));
    return () => {
      gone = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [file.id, kind]);

  return (
    <div className={`viewer ${closing ? "closing" : ""}`} data-testid="file-viewer" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`viewer-sheet kind-${kind}`} ref={sheet} tabIndex={-1} role="dialog" aria-modal="true" aria-label={file.name}>
        <header className="viewer-head">
          <Sheet name={file.name} />
          <span className="viewer-title">
            <span className="viewer-name">{file.name}</span>
            <span className="viewer-meta">
              {KIND_LABEL[kind]} · {bytes(file.size)} · {file.origin === "produced" ? "Made by Vireo" : "From you"}
            </span>
          </span>
          <a className="peek-btn download" href={fileUrl(file.id)} download={file.name} target="_blank" rel="noreferrer" data-testid="viewer-download">
            <DownloadIcon />
            Download
          </a>
          <button className="peek-btn icon" onClick={close} aria-label="Close" data-testid="viewer-close">
            <CloseIcon />
          </button>
        </header>
        <div className="viewer-body">
          <Preview file={file} kind={kind} content={content} />
        </div>
      </div>
    </div>
  );
}

function Preview({ file, kind, content }: { file: FileInfo; kind: Kind; content: Content }) {
  if (kind === "image") return <img className="viewer-image" src={fileUrl(file.id)} alt={file.name} />;
  if (kind === "other") return <p className="viewer-note">There's no preview for this kind of file. Download it to open it.</p>;
  if (!content) return <p className="viewer-note">Loading…</p>;
  if ("error" in content) return <p className="viewer-note">Couldn't open this file: {content.error}</p>;
  if ("url" in content) return <iframe className="viewer-frame" src={content.url} title={file.name} />;
  const text = content.text;
  switch (kind) {
    case "html":
      // A page Vireo made runs in a sandbox: its scripts work, but it can't reach the app or the node.
      return <iframe className="viewer-frame" srcDoc={text} sandbox="allow-scripts allow-popups allow-forms allow-modals" title={file.name} data-testid="viewer-page" />;
    case "markdown":
      return (
        <div className="viewer-doc">
          <Markdown text={text} />
        </div>
      );
    case "table":
      return <Table text={text} tab={extOf(file.name) === "tsv" || file.mime === "text/tab-separated-values"} />;
    default:
      return <pre className="viewer-text">{text}</pre>;
  }
}

const MAX_ROWS = 500;

function Table({ text, tab }: { text: string; tab: boolean }) {
  const rows = parseRows(text, tab ? "\t" : ",");
  const [head, ...body] = rows;
  if (!head) return <p className="viewer-note">This table is empty.</p>;
  return (
    <div className="viewer-table">
      <table>
        <thead>
          <tr>
            {head.map((c, i) => (
              <th key={i}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, MAX_ROWS).map((r, i) => (
            <tr key={i}>
              {head.map((_, j) => (
                <td key={j}>{r[j] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > MAX_ROWS ? <p className="viewer-note">Showing {MAX_ROWS} of {body.length} rows. Download the file for the rest.</p> : null}
    </div>
  );
}

/** Rows of a CSV or TSV, with quoted fields that may hold separators, quotes and line breaks. */
function parseRows(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows.filter((r) => r.some((c) => c.trim()));
}
