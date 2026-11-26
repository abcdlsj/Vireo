import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fileInlineUrl, fileUrl, type FileInfo } from "../api";
import { bytes } from "../format";
import { AudioIcon, CheckIcon, CloseIcon, CodeIcon, CopyIcon, DownloadIcon, EyeIcon, FullscreenIcon, PlayIcon } from "../icons";
import { Markdown } from "../markdown";

export type FileKind = "image" | "svg" | "pdf" | "html" | "markdown" | "table" | "json" | "code" | "text" | "document" | "audio" | "video" | "other";

export type FilePreviewTarget =
  | { kind: "info"; file: FileInfo }
  | { kind: "id"; fileId: string; name?: string; mime?: string }
  | { kind: "local"; file: File };

/** Normalises a FileInfo, a fileId reference, or a local File into a preview target. */
export function toPreviewTarget(input: FileInfo | File | { fileId: string; name?: string; mime?: string }): FilePreviewTarget {
  if (input instanceof File) return { kind: "local", file: input };
  if ("fileId" in input) return { kind: "id", fileId: input.fileId, name: input.name, mime: input.mime };
  return { kind: "info", file: input };
}

const PREVIEW_EVENT = "vireo:file-preview";
let splitHandler: ((target: FilePreviewTarget) => boolean) | null = null;

/** Lets a desktop ThreadView intercept preview requests into its right-side Split Preview Drawer. */
export function registerSplitPreviewHandler(fn: ((target: FilePreviewTarget) => boolean) | null): void {
  splitHandler = fn;
}

/**
 * Opens a file in preview from anywhere in the app (Home board cards, Peek sheet,
 * Composer pending files, Thread cards/attachments). When a desktop ThreadView split
 * drawer is registered and `forceFullscreen` is false, it opens side-by-side without
 * interrupting the conversation; otherwise it opens in the fullscreen Lightbox.
 */
export function openFilePreview(
  input: FileInfo | File | { fileId: string; name?: string; mime?: string },
  opts?: { forceFullscreen?: boolean },
): void {
  const target = toPreviewTarget(input);
  if (!opts?.forceFullscreen && splitHandler && splitHandler(target)) return;
  window.dispatchEvent(new CustomEvent<FilePreviewTarget>(PREVIEW_EVENT, { detail: target }));
}

export const extOf = (name: string) => name.match(/\.(\w{1,8})$/)?.[1]?.toLowerCase() ?? "";

/** How a file is previewed, from its type and name. */
export function fileKind(f: { mime: string; name: string }): FileKind {
  const ext = extOf(f.name);
  if (f.mime === "image/svg+xml" || ext === "svg") return "svg";
  if (f.mime.startsWith("image/") || /^(png|jpe?g|gif|webp|avif|bmp|ico)$/.test(ext)) return "image";
  if (f.mime.startsWith("audio/") || /^(mp3|wav|ogg|m4a|flac|aac|opus)$/.test(ext)) return "audio";
  if (f.mime.startsWith("video/") || /^(mp4|webm|mov|m4v|ogv)$/.test(ext)) return "video";
  if (f.mime === "application/pdf" || ext === "pdf") return "pdf";
  if (f.mime === "text/html" || ext === "html" || ext === "htm") return "html";
  if (f.mime === "text/markdown" || ext === "md" || ext === "markdown") return "markdown";
  if (f.mime === "text/csv" || f.mime === "text/tab-separated-values" || ext === "csv" || ext === "tsv") return "table";
  if (f.mime === "application/json" || ext === "json") return "json";
  if (ext === "docx" || f.mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "document";
  if (/^(js|jsx|ts|tsx|py|go|rs|java|rb|sh|bash|zsh|sql|toml|ini|css|scss|less|xml|ya?ml|c|cpp|h|swift|kt|php)$/.test(ext) || /application\/(xml|yaml|x-yaml|javascript)/.test(f.mime)) {
    return "code";
  }
  if (f.mime.startsWith("text/") || /^(txt|log|ics|env|conf|gitignore)$/.test(ext)) return "text";
  return "other";
}

const PHONE = "(max-width: 760px)";

export const KIND_LABEL: Record<FileKind, string> = {
  image: "Image",
  svg: "Vector",
  pdf: "PDF",
  html: "Interactive Page",
  markdown: "Document",
  table: "Table",
  json: "JSON",
  code: "Code",
  text: "Text",
  document: "Word Doc",
  audio: "Audio",
  video: "Video",
  other: "File",
};

/** Small paper extension badge. */
export function Sheet({ name }: { name: string }) {
  const ext = extOf(name) || "file";
  return <span className={`attach-sheet ext-${ext}`}>{ext.slice(0, 4).toUpperCase()}</span>;
}

/* ---------- Tier 1: Cached Live Inline Preview Stage (for File cards & produced attachments) ---------- */

type SnippetState = { text?: string; rows?: string[][]; status: "loading" | "ready" | "error" };
const snippetCache = new Map<string, SnippetState>();

function useFileSnippet(fileId: string, kind: FileKind, enabled: boolean): SnippetState | null {
  const [state, setState] = useState<SnippetState | null>(() => (fileId ? snippetCache.get(fileId) ?? null : null));
  useEffect(() => {
    if (!enabled || !fileId) return;
    if (kind === "image" || kind === "svg" || kind === "audio" || kind === "video" || kind === "other") return;
    const cached = snippetCache.get(fileId);
    if (cached && cached.status === "ready") {
      setState(cached);
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    const load = async () => {
      let text = "";
      if (kind === "pdf" || kind === "document") {
        const res = await api.get<{ text: string }>(`/api/files/${fileId}/text`);
        text = res.text;
      } else {
        const res = await fetch(fileUrl(fileId));
        if (!res.ok) throw new Error(res.statusText);
        text = await res.text();
      }
      const next: SnippetState =
        kind === "table"
          ? { status: "ready", rows: parseRows(text.slice(0, 8000), text.includes("\t") && !text.includes(",") ? "\t" : ",").slice(0, 5) }
          : { status: "ready", text: text.slice(0, 12000) };
      snippetCache.set(fileId, next);
      if (!cancelled) setState(next);
    };
    void load().catch(() => {
      if (!cancelled) setState({ status: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [fileId, kind, enabled]);
  return state;
}

/**
 * Miniature visual preview window used inside File cards and produced attachment tiles.
 * Renders actual thumbnails for images/SVG, scaled HTML micro-frames, real CSV mini-tables,
 * or clean typographic document/code excerpts.
 */
export function FileInlineStage({
  fileId,
  name,
  mime = "",
  compact = false,
  fallbackText,
}: {
  fileId: string;
  name: string;
  mime?: string;
  compact?: boolean;
  fallbackText?: string;
}) {
  const kind = fileKind({ name, mime });
  const snippet = useFileSnippet(fileId, kind, Boolean(fileId));
  const ext = (extOf(name) || "file").toUpperCase();

  if (fileId && (kind === "image" || kind === "svg")) {
    return (
      <div className={`file-stage media ${compact ? "compact" : ""}`}>
        <img src={fileUrl(fileId)} alt={name} loading="lazy" />
      </div>
    );
  }

  if (kind === "audio" || kind === "video") {
    return (
      <div className={`file-stage av ${kind} ${compact ? "compact" : ""}`}>
        <span className="file-stage-play" aria-hidden="true">
          {kind === "audio" ? <AudioIcon /> : <PlayIcon />}
        </span>
        <span className="file-stage-av-label">{kind === "audio" ? "Audio clip · Click to play" : "Video clip · Click to play"}</span>
      </div>
    );
  }

  if (kind === "html" && snippet?.status === "ready" && snippet.text) {
    return (
      <div className={`file-stage html ${compact ? "compact" : ""}`}>
        <div className="file-stage-paper html-frame-wrap">
          <iframe className="file-stage-iframe" srcDoc={snippet.text} sandbox="" title={`Preview of ${name}`} tabIndex={-1} loading="lazy" />
        </div>
      </div>
    );
  }

  if (kind === "table" && snippet?.status === "ready" && snippet.rows?.length) {
    const [head, ...rows] = snippet.rows;
    const cols = head ? head.slice(0, 4) : [];
    return (
      <div className={`file-stage table ${compact ? "compact" : ""}`}>
        <div className="file-stage-paper">
          <table className="file-mini-table">
            <thead>
              <tr>
                {cols.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, compact ? 3 : 4).map((r, i) => (
                <tr key={i}>
                  {cols.map((_, j) => (
                    <td key={j}>{r[j] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const rawText = snippet?.status === "ready" ? snippet.text : fallbackText;
  if (rawText) {
    const clean =
      kind === "markdown"
        ? rawText
            .replace(/^#{1,6}\s+/gm, "")
            .replace(/[*_`~]/g, "")
            .trim()
        : rawText.trim();
    const lines = clean.split(/\r?\n/).filter((l) => l.trim()).slice(0, compact ? 4 : 6);
    const isCode = kind === "code" || kind === "json";
    return (
      <div className={`file-stage doc ${isCode ? "is-code" : ""} ${compact ? "compact" : ""}`}>
        <div className="file-stage-paper">
          {lines.map((line, i) => (
            <div key={i} className={i === 0 && !isCode ? "file-mini-lead" : "file-mini-line"}>
              {line.slice(0, 90)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`file-stage placeholder ${compact ? "compact" : ""}`}>
      <div className="file-stage-paper is-empty">
        <span className={`file-stage-ext ext-${ext.toLowerCase()}`}>{ext.slice(0, 5)}</span>
        <span className="file-stage-hint">{snippet?.status === "loading" ? "Loading preview…" : `${KIND_LABEL[kind]} preview`}</span>
      </div>
    </div>
  );
}

/* ---------- Attachments in Conversation Stream ---------- */

/**
 * Files on a message: the owner's uploads above their bubble, and what Vireo
 * made under its reply as Curated Gallery Print cards with live previews.
 */
export function Attachments({
  files,
  onOpen,
  produced,
  activeId,
}: {
  files: FileInfo[];
  onOpen: (f: FileInfo) => void;
  produced?: boolean;
  activeId?: string | null;
}) {
  if (!files.length) return null;
  if (produced) {
    return (
      <div className="attachments produced gallery" data-testid="produced-files">
        {files.map((f) => {
          const kind = fileKind(f);
          const ext = (extOf(f.name) || "file").toUpperCase();
          return (
            <button
              key={f.id}
              type="button"
              className={`attach-card ${activeId === f.id ? "active" : ""}`}
              onClick={() => onOpen(f)}
              data-testid="attachment"
              title={`Preview ${f.name}`}
            >
              <FileInlineStage fileId={f.id} name={f.name} mime={f.mime} compact />
              <span className="attach-card-foot">
                <span className="attach-text">
                  <span className="attach-name">{f.name}</span>
                  <span className="attach-meta">
                    {KIND_LABEL[kind]} · {bytes(f.size)}
                  </span>
                </span>
                <span className={`attach-ext-pill ext-${ext.toLowerCase()}`}>{ext.slice(0, 4)}</span>
              </span>
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div className="attachments" data-testid="attachments">
      {files.map((f) =>
        fileKind(f) === "image" || fileKind(f) === "svg" ? (
          <button key={f.id} type="button" className="attach-image" onClick={() => onOpen(f)} aria-label={`Open ${f.name}`} data-testid="attachment">
            <img src={fileUrl(f.id)} alt={f.name} />
          </button>
        ) : (
          <button key={f.id} type="button" className={`attach ${activeId === f.id ? "active" : ""}`} onClick={() => onOpen(f)} data-testid="attachment" title={f.name}>
            <Sheet name={f.name} />
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

/** A file waiting in the composer, before it is sent. Clickable to preview locally! */
export function PendingFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [thumb, setThumb] = useState("");
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <span className="attach pending" title={`Click to preview ${file.name}`}>
      <button type="button" className="attach-pending-open" onClick={() => openFilePreview(file, { forceFullscreen: true })}>
        {thumb ? <img className="attach-thumb" src={thumb} alt="" /> : <Sheet name={file.name} />}
        <span className="attach-text">
          <span className="attach-name">{file.name}</span>
          <span className="attach-meta">
            {bytes(file.size)} · Preview
          </span>
        </span>
      </button>
      <button type="button" className="attach-remove" onClick={onRemove} aria-label={`Remove ${file.name}`}>
        <CloseIcon />
      </button>
    </span>
  );
}

/* ---------- Shared File Preview Engine (Tier 2 Split Drawer + Tier 3 Fullscreen Lightbox) ---------- */

type LoadedContent =
  | { text: string }
  | { url: string; fallbackText?: string }
  | { error: string }
  | null;

interface ResolvedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  origin?: "upload" | "produced";
  downloadUrl: string;
  inlineUrl: string;
  localFile?: File;
}

function useResolvedFile(target: FilePreviewTarget): { file: ResolvedFile | null; error: string } {
  const [resolved, setResolved] = useState<ResolvedFile | null>(() => {
    if (target.kind === "info") {
      return {
        id: target.file.id,
        name: target.file.name,
        mime: target.file.mime,
        size: target.file.size,
        origin: target.file.origin,
        downloadUrl: fileUrl(target.file.id),
        inlineUrl: fileInlineUrl(target.file.id),
      };
    }
    if (target.kind === "id" && target.name) {
      return {
        id: target.fileId,
        name: target.name,
        mime: target.mime ?? "",
        size: 0,
        downloadUrl: fileUrl(target.fileId),
        inlineUrl: fileInlineUrl(target.fileId),
      };
    }
    return null;
  });
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let localUrl = "";
    setError("");
    if (target.kind === "info") {
      setResolved({
        id: target.file.id,
        name: target.file.name,
        mime: target.file.mime,
        size: target.file.size,
        origin: target.file.origin,
        downloadUrl: fileUrl(target.file.id),
        inlineUrl: fileInlineUrl(target.file.id),
      });
      return;
    }
    if (target.kind === "local") {
      localUrl = URL.createObjectURL(target.file);
      setResolved({
        id: `local:${target.file.name}:${target.file.size}`,
        name: target.file.name,
        mime: target.file.type || "application/octet-stream",
        size: target.file.size,
        downloadUrl: localUrl,
        inlineUrl: localUrl,
        localFile: target.file,
      });
      return () => {
        if (localUrl) URL.revokeObjectURL(localUrl);
      };
    }
    // target.kind === "id": fetch full FileInfo metadata
    void api
      .get<{ file: FileInfo }>(`/api/files/${target.fileId}/meta`)
      .then((r) => {
        if (cancelled) return;
        setResolved({
          id: r.file.id,
          name: r.file.name,
          mime: r.file.mime,
          size: r.file.size,
          origin: r.file.origin,
          downloadUrl: fileUrl(r.file.id),
          inlineUrl: fileInlineUrl(r.file.id),
        });
      })
      .catch((err) => {
        if (cancelled) return;
        if (!target.name) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  return { file: resolved, error };
}

function useFileContent(file: ResolvedFile | null, kind: FileKind, mode: "preview" | "source"): LoadedContent {
  const [content, setContent] = useState<LoadedContent>(null);
  useEffect(() => {
    if (!file) return;
    let revoke = "";
    let gone = false;
    setContent(null);

    const load = async (): Promise<LoadedContent> => {
      if (kind === "image" || kind === "audio" || kind === "video" || kind === "other") return null;
      if (file.localFile) {
        if (kind === "pdf") {
          revoke = URL.createObjectURL(file.localFile);
          return { url: revoke };
        }
        if (kind === "document") return { error: "Send this Word document to preview its extracted text." };
        return { text: await file.localFile.text() };
      }
      if (kind === "document" || (kind === "pdf" && (mode === "source" || window.matchMedia(PHONE).matches))) {
        return { text: (await api.get<{ text: string }>(`/api/files/${file.id}/text`)).text };
      }
      const res = await fetch(file.downloadUrl);
      if (!res.ok) throw new Error(res.statusText);
      if (kind === "pdf") {
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
  }, [file?.id, file?.downloadUrl, file?.localFile, kind, mode]);

  return content;
}

const HAS_SOURCE_TOGGLE = new Set<FileKind>(["html", "svg", "markdown", "table", "json", "pdf"]);

function FilePreviewSurface({
  target,
  variant,
  onClose,
  onExpand,
}: {
  target: FilePreviewTarget;
  variant: "drawer" | "modal";
  onClose: () => void;
  onExpand?: () => void;
}) {
  const { file, error } = useResolvedFile(target);
  const kind: FileKind = file ? fileKind({ mime: file.mime, name: file.name }) : "other";
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);
  const [zoom, setZoom] = useState<"fit" | "actual">("fit");

  useEffect(() => {
    setMode("preview");
    setZoom("fit");
    setCopied(false);
  }, [file?.id]);

  const content = useFileContent(file, kind, mode);
  const canToggleSource = Boolean(file && HAS_SOURCE_TOGGLE.has(kind) && !(kind === "pdf" && file.localFile));
  const copyableText = content && "text" in content ? content.text : null;

  const copyText = () => {
    if (!copyableText || !navigator.clipboard) return;
    void navigator.clipboard.writeText(copyableText).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  if (error || !file) {
    return (
      <>
        <header className="viewer-head">
          <span className="viewer-title">
            <span className="viewer-name">{error ? "Couldn't open file" : "Loading file…"}</span>
          </span>
          <button type="button" className="peek-btn icon" onClick={onClose} aria-label="Close" data-testid="viewer-close">
            <CloseIcon />
          </button>
        </header>
        <div className="viewer-body">
          <p className="viewer-note">{error || "Loading…"}</p>
        </div>
      </>
    );
  }

  const originLabel = file.localFile ? "Ready to send" : file.origin === "produced" ? "Made by Vireo" : file.origin === "upload" ? "From you" : "";
  const metaLine = [KIND_LABEL[kind], file.size ? bytes(file.size) : "", originLabel].filter(Boolean).join(" · ");

  return (
    <>
      <header className="viewer-head">
        <Sheet name={file.name} />
        <span className="viewer-title">
          <span className="viewer-name" title={file.name}>
            {file.name}
          </span>
          <span className="viewer-meta">{metaLine}</span>
        </span>
        <div className="viewer-actions">
          {canToggleSource ? (
            <button
              type="button"
              className={`viewer-pill ${mode === "source" ? "on" : ""}`}
              onClick={() => setMode((m) => (m === "preview" ? "source" : "preview"))}
              title={mode === "preview" ? (kind === "pdf" ? "View extracted text" : "View source") : "View rendered preview"}
              data-testid="viewer-mode"
            >
              {mode === "preview" ? <CodeIcon /> : <EyeIcon />}
              <span>{mode === "preview" ? (kind === "pdf" ? "Text" : "Source") : "Preview"}</span>
            </button>
          ) : null}
          {kind === "image" ? (
            <button type="button" className={`viewer-pill ${zoom === "actual" ? "on" : ""}`} onClick={() => setZoom((z) => (z === "fit" ? "actual" : "fit"))}>
              <span>{zoom === "fit" ? "100%" : "Fit"}</span>
            </button>
          ) : null}
          {copyableText ? (
            <button type="button" className={`viewer-pill ${copied ? "copied" : ""}`} onClick={copyText} title="Copy content">
              {copied ? <CheckIcon /> : <CopyIcon />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          ) : null}
          {variant === "drawer" && onExpand ? (
            <button type="button" className="peek-btn icon" onClick={onExpand} aria-label="Fullscreen preview" title="Fullscreen" data-testid="viewer-expand">
              <FullscreenIcon />
            </button>
          ) : null}
          <a className="peek-btn download" href={file.downloadUrl} download={file.name} target="_blank" rel="noreferrer" data-testid="viewer-download">
            <DownloadIcon />
            <span>Download</span>
          </a>
          <button type="button" className="peek-btn icon" onClick={onClose} aria-label="Close" data-testid="viewer-close">
            <CloseIcon />
          </button>
        </div>
      </header>
      <div className={`viewer-body kind-${kind} mode-${mode}`}>
        <PreviewBody file={file} kind={kind} content={content} mode={mode} zoom={zoom} />
      </div>
    </>
  );
}

/** Tier 2: Floating Right-Side Split Preview Drawer inside ThreadView (never blocks conversation). */
export function FilePreviewDrawer({
  target,
  onClose,
  onExpand,
}: {
  target: FilePreviewTarget;
  onClose: () => void;
  onExpand: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[data-testid="card-share"]') && !document.querySelector(".viewer.modal-layer")) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="file-drawer" data-testid="file-viewer" aria-label="File preview">
      <FilePreviewSurface target={target} variant="drawer" onClose={onClose} onExpand={onExpand} />
    </aside>
  );
}

/** Tier 3: Fullscreen Lightbox Modal (for Home board, Peek, PendingFile, mobile, or expanded Drawer). */
export function FileViewer({
  file,
  target,
  onClose,
}: {
  file?: FileInfo;
  target?: FilePreviewTarget;
  onClose: () => void;
}) {
  const resolvedTarget = useMemo<FilePreviewTarget>(() => target ?? { kind: "info", file: file! }, [target, file]);
  const [closing, setClosing] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setClosing(true);
    window.setTimeout(onClose, 160);
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheet.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[data-testid="card-share"]')) close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [close]);

  const probe = resolvedTarget.kind === "info" ? resolvedTarget.file : resolvedTarget.kind === "local" ? { name: resolvedTarget.file.name, mime: resolvedTarget.file.type } : { name: resolvedTarget.name ?? "", mime: resolvedTarget.mime ?? "" };
  const kind = fileKind(probe);

  return (
    <div className={`viewer modal-layer ${closing ? "closing" : ""}`} data-testid="file-viewer" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`viewer-sheet kind-${kind}`} ref={sheet} tabIndex={-1} role="dialog" aria-modal="true" aria-label={probe.name || "File preview"}>
        <FilePreviewSurface target={resolvedTarget} variant="modal" onClose={close} />
      </div>
    </div>
  );
}

/** Mounted once at Shell level so any card, Peek sheet, or Composer pending file can open a file preview. */
export function FileViewerHost() {
  const [target, setTarget] = useState<FilePreviewTarget | null>(null);
  useEffect(() => {
    const on = (e: Event) => setTarget((e as CustomEvent<FilePreviewTarget>).detail);
    window.addEventListener(PREVIEW_EVENT, on);
    return () => window.removeEventListener(PREVIEW_EVENT, on);
  }, []);
  if (!target) return null;
  return <FileViewer target={target} onClose={() => setTarget(null)} />;
}

/* ---------- Preview Renderers by File Kind ---------- */

function PreviewBody({
  file,
  kind,
  content,
  mode,
  zoom,
}: {
  file: ResolvedFile;
  kind: FileKind;
  content: LoadedContent;
  mode: "preview" | "source";
  zoom: "fit" | "actual";
}) {
  if (kind === "image") {
    return (
      <div className={`viewer-image-stage ${zoom}`}>
        <img className="viewer-image" src={file.inlineUrl} alt={file.name} />
      </div>
    );
  }
  if (kind === "audio") {
    return (
      <div className="viewer-media-stage">
        <div className="viewer-audio-card">
          <span className="viewer-audio-icon" aria-hidden="true">
            <AudioIcon />
          </span>
          <div className="viewer-audio-name">{file.name}</div>
          <audio controls src={file.inlineUrl} className="viewer-audio" />
        </div>
      </div>
    );
  }
  if (kind === "video") {
    return (
      <div className="viewer-media-stage dark">
        <video controls playsInline src={file.inlineUrl} className="viewer-video" />
      </div>
    );
  }
  if (kind === "other") {
    return (
      <div className="viewer-empty">
        <Sheet name={file.name} />
        <p className="viewer-note">There's no inline preview for this file type yet. Download it to open locally.</p>
      </div>
    );
  }
  if (!content) return <p className="viewer-note">Loading preview…</p>;
  if ("error" in content) return <p className="viewer-note">Couldn't open this file: {content.error}</p>;
  if ("url" in content) return <iframe className="viewer-frame" src={content.url} title={file.name} />;

  const text = content.text;
  if (mode === "source") {
    return <CodeBlock text={text} />;
  }

  switch (kind) {
    case "svg":
      return (
        <div className={`viewer-image-stage ${zoom}`}>
          <img className="viewer-image" src={file.inlineUrl} alt={file.name} />
        </div>
      );
    case "html":
      return <iframe className="viewer-frame" srcDoc={text} sandbox="allow-scripts allow-popups allow-forms allow-modals" title={file.name} data-testid="viewer-page" />;
    case "markdown":
      return (
        <div className="viewer-doc-wrap">
          <article className="viewer-doc">
            <Markdown text={text} />
          </article>
        </div>
      );
    case "document": {
      const paragraphs = text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
      return (
        <div className="viewer-doc-wrap">
          <article className="viewer-doc docx">
            {paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </article>
        </div>
      );
    }
    case "table":
      return <Table text={text} tab={extOf(file.name) === "tsv" || file.mime === "text/tab-separated-values"} />;
    case "json": {
      let formatted = text;
      try {
        formatted = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Keep original text if invalid JSON
      }
      return <CodeBlock text={formatted} />;
    }
    case "code":
      return <CodeBlock text={text} />;
    default:
      return <pre className="viewer-text">{text}</pre>;
  }
}

function CodeBlock({ text }: { text: string }) {
  const lines = useMemo(() => text.split(/\r?\n/), [text]);
  const showNumbers = lines.length <= 2500;
  if (!showNumbers) return <pre className="viewer-text">{text}</pre>;
  return (
    <div className="viewer-code-wrap">
      <div className="viewer-code-gutter" aria-hidden="true">
        {lines.map((_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <pre className="viewer-code">{text}</pre>
    </div>
  );
}

const MAX_ROWS = 500;

function Table({ text, tab }: { text: string; tab: boolean }) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => parseRows(text, tab ? "\t" : ","), [text, tab]);
  const [head, ...body] = rows;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return body;
    return body.filter((r) => r.some((c) => c.toLowerCase().includes(q)));
  }, [body, query]);

  if (!head) return <p className="viewer-note">This table is empty.</p>;
  return (
    <div className="viewer-table">
      <div className="viewer-table-bar">
        <span className="viewer-table-meta">
          {filtered.length}
          {query.trim() ? ` of ${body.length}` : ""} rows · {head.length} columns
        </span>
        {body.length > 6 ? (
          <input
            type="search"
            className="viewer-table-search"
            placeholder="Filter rows…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter table rows"
          />
        ) : null}
      </div>
      <div className="viewer-table-scroll">
        <table>
          <thead>
            <tr>
              {head.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, MAX_ROWS).map((r, i) => (
              <tr key={i}>
                {head.map((_, j) => (
                  <td key={j}>{r[j] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length > MAX_ROWS ? <p className="viewer-note">Showing {MAX_ROWS} of {filtered.length} rows. Download the file for the rest.</p> : null}
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
