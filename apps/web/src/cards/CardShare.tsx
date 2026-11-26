import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Card } from "@vireo/protocol";
import { CheckIcon, CloseIcon, CopyIcon, DownloadIcon, FullscreenIcon } from "../icons";
import { cardView } from "./registry";
import { resolvedTheme } from "../theme";

type Ratio = "auto" | "xhs" | "x" | "square" | "story";
type Backdrop = "alabaster" | "botanical" | "sand" | "slate" | "obsidian" | "forest";
type CardSurface = "auto" | "light" | "dark";
type PosterStyle = "gallery" | "editorial";

const RATIOS: { id: Ratio; label: string; hint: string; w: number; minH?: number }[] = [
  { id: "auto", label: "Auto", hint: "Fit", w: 540 },
  { id: "xhs", label: "3:4", hint: "小红书", w: 480, minH: 640 },
  { id: "x", label: "16:9", hint: "封面", w: 720, minH: 405 },
  { id: "square", label: "1:1", hint: "方图", w: 560, minH: 560 },
  { id: "story", label: "9:16", hint: "竖屏", w: 450, minH: 800 },
];

const BACKDROPS: { id: Backdrop; label: string; swatch: string; dark?: boolean }[] = [
  { id: "alabaster", label: "Alabaster", swatch: "linear-gradient(145deg, #f7f5ef, #eae5d9)" },
  { id: "botanical", label: "Botanical", swatch: "linear-gradient(145deg, #e7f0ea, #d3e3d8)" },
  { id: "sand", label: "Warm Sand", swatch: "linear-gradient(145deg, #f6ece0, #ead8c7)" },
  { id: "slate", label: "Nordic", swatch: "linear-gradient(145deg, #eceff4, #dce2ec)" },
  { id: "obsidian", label: "Obsidian", swatch: "linear-gradient(145deg, #20211f, #0d0e0d)", dark: true },
  { id: "forest", label: "Deep Pine", swatch: "linear-gradient(145deg, #1b3a29, #0a1710)", dark: true },
];

const KIND_EDITION: Record<string, string> = {
  flight: "BOARDING PASS",
  trip: "ITINERARY",
  watch: "TELEMETRY",
  reminder: "SCHEDULE",
  file: "ARTIFACT",
  document: "MANUSCRIPT",
  email: "CORRESPONDENCE",
  event: "CALENDAR",
  compare: "DECISION MATRIX",
  summary: "BRIEFING",
  answer: "INSIGHT",
  github_pr: "PULL REQUEST",
  github_repo: "REPOSITORY",
  place: "CITY GUIDE",
  person: "DOSSIER",
  web_page: "CLIPPING",
  proposal: "PROPOSAL",
  card: "DISPATCH",
  thread: "NOTE",
};

const SHARE_EVENT = "vireo:card-share";

/** Opens the Poster Studio for any card from anywhere in the app. */
export function openCardShare(card: Card): void {
  window.dispatchEvent(new CustomEvent<Card>(SHARE_EVENT, { detail: card }));
}

/** Listens for poster studio requests at the Shell level so any card (board, peek, thread) can open it. */
export function CardShareHost() {
  const [card, setCard] = useState<Card | null>(null);
  useEffect(() => {
    const on = (e: Event) => setCard((e as CustomEvent<Card>).detail);
    window.addEventListener(SHARE_EVENT, on);
    return () => window.removeEventListener(SHARE_EVENT, on);
  }, []);
  if (!card) return null;
  return <CardShareModal card={card} onClose={() => setCard(null)} />;
}

/**
 * Museum-grade Poster Studio: frames any Vireo card as a Gallery Print or Editorial
 * Poster with auto-fit scaled preview and crisp 2x Retina PNG export.
 */
function CardShareModal({ card, onClose }: { card: Card; onClose: () => void }) {
  const [ratio, setRatio] = useState<Ratio>("xhs");
  const [style, setStyle] = useState<PosterStyle>("gallery");
  const [backdrop, setBackdrop] = useState<Backdrop>(() => (resolvedTheme() === "dark" ? "obsidian" : "alabaster"));
  const [surface, setSurface] = useState<CardSurface>("auto");
  const [brand, setBrand] = useState(true);
  const [caption, setCaption] = useState("");
  const [cleanStage, setCleanStage] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "copy">("");
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState("");
  const [scale, setScale] = useState(1);

  const stageWrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (cleanStage) setCleanStage(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cleanStage, onClose]);

  // Smoothly auto-fit the poster canvas inside the preview viewport so tall 3:4 / 9:16 posters never clip.
  useLayoutEffect(() => {
    const wrap = stageWrapRef.current;
    const canvas = stageRef.current;
    if (!wrap || !canvas) return;
    const measure = () => {
      const pad = cleanStage ? 48 : 56;
      const availW = Math.max(180, wrap.clientWidth - pad);
      const availH = Math.max(180, wrap.clientHeight - pad);
      const cw = canvas.offsetWidth || 500;
      const ch = canvas.offsetHeight || 500;
      const next = Math.min(1, availW / cw, availH / ch);
      setScale(Math.max(0.35, Number(next.toFixed(3))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [ratio, style, backdrop, surface, brand, caption, cleanStage]);

  const effectiveSurface = surface === "auto" ? (BACKDROPS.find((b) => b.id === backdrop)?.dark ? "dark" : "light") : surface;
  const view = cardView(card.kind);
  const isWide = (typeof view.size === "function" ? view.size(card) : view.size) === "l";
  const edition = KIND_EDITION[card.kind] ?? "CURATED";
  const dateStr = new Date(card.updatedAt || Date.now()).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  const exportImage = useCallback(
    async (mode: "save" | "copy") => {
      const el = stageRef.current;
      if (!el || busy) return;
      setBusy(mode);
      setNote("");
      try {
        if (mode === "copy" && navigator.clipboard && typeof ClipboardItem !== "undefined") {
          const pngPromise = renderNodeToPng(el, 2);
          await navigator.clipboard.write([new ClipboardItem({ "image/png": pngPromise })]);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        } else {
          const blob = await renderNodeToPng(el, 2);
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          const slug =
            (card.title || card.kind)
              .toLowerCase()
              .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
              .replace(/^-|-$/g, "")
              .slice(0, 40) || "vireo-poster";
          a.href = url;
          a.download = `vireo-${slug}.png`;
          a.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      } catch {
        setNote("Use Clean stage to take a crisp native screenshot.");
      } finally {
        setBusy("");
      }
    },
    [busy, card.kind, card.title],
  );

  const canvasH = stageRef.current?.offsetHeight ?? 540;
  const canvasW = stageRef.current?.offsetWidth ?? 480;

  return (
    <div
      className={`poster-overlay ${cleanStage ? "clean" : ""}`}
      data-testid="card-share"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (cleanStage) setCleanStage(false);
        else onClose();
      }}
    >
      <div className="poster-studio" role="dialog" aria-modal="true" aria-label="Share card as poster">
        {!cleanStage ? (
          <header className="poster-head">
            <div className="poster-head-title">
              <span className="poster-head-eyebrow">Poster Studio · {edition}</span>
              <h2>{card.title}</h2>
            </div>
            <div className="poster-head-actions">
              <span className="poster-zoom-pill" title="Live preview scale">
                {Math.round(scale * 100)}%
              </span>
              <button type="button" className="peek-btn" onClick={() => setCleanStage(true)} title="Hide controls for a clean native screenshot">
                <FullscreenIcon />
                <span>Clean stage</span>
              </button>
              <button type="button" className="peek-btn" disabled={busy !== ""} onClick={() => void exportImage("copy")}>
                {copied ? <CheckIcon /> : <CopyIcon />}
                <span>{copied ? "Copied" : busy === "copy" ? "Copying…" : "Copy PNG"}</span>
              </button>
              <button type="button" className="cbtn primary small" disabled={busy !== ""} onClick={() => void exportImage("save")}>
                <DownloadIcon />
                <span>{busy === "save" ? "Saving…" : "Save PNG"}</span>
              </button>
              <button type="button" className="peek-btn icon" onClick={onClose} aria-label="Close">
                <CloseIcon />
              </button>
            </div>
          </header>
        ) : (
          <button type="button" className="poster-exit-clean" onClick={() => setCleanStage(false)}>
            Exit clean stage · Esc
          </button>
        )}

        <div className="poster-workspace">
          <div className="poster-stage-wrap" ref={stageWrapRef}>
            <div
              className="poster-scale-box"
              style={{
                width: Math.round(canvasW * scale),
                height: Math.round(canvasH * scale),
              }}
            >
              <div
                ref={stageRef}
                className={`poster-canvas style-${style} ratio-${ratio} bg-${backdrop} ${isWide ? "wide-card" : "compact-card"}`}
                data-theme={effectiveSurface}
                style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}
              >
                <div className="poster-grain" aria-hidden="true" />
                {style === "editorial" ? (
                  <header className="poster-masthead">
                    <span className="poster-edition-tag">{edition}</span>
                    <span className="poster-edition-date">{dateStr}</span>
                  </header>
                ) : null}
                <div className="poster-card-shell">{view.render({ card, expanded: true, refresh: () => undefined })}</div>
                {brand ? (
                  <footer className="poster-colophon">
                    <span className="poster-brand">
                      <img src="/icon.svg" alt="" width={16} height={16} />
                      <span>Vireo</span>
                    </span>
                    <span className="poster-meta">{caption.trim() || dateStr}</span>
                  </footer>
                ) : null}
              </div>
            </div>
          </div>

          {!cleanStage ? (
            <aside className="poster-controls">
              <div className="poster-ctrl-group">
                <span className="poster-ctrl-label">Composition</span>
                <div className="poster-seg two">
                  <button type="button" className={style === "gallery" ? "on" : ""} onClick={() => setStyle("gallery")}>
                    Gallery Print
                  </button>
                  <button type="button" className={style === "editorial" ? "on" : ""} onClick={() => setStyle("editorial")}>
                    Editorial Poster
                  </button>
                </div>
              </div>

              <div className="poster-ctrl-group">
                <span className="poster-ctrl-label">Aspect Ratio</span>
                <div className="poster-pills">
                  {RATIOS.map((r) => (
                    <button key={r.id} type="button" className={`poster-pill ${ratio === r.id ? "on" : ""}`} onClick={() => setRatio(r.id)}>
                      <b>{r.label}</b>
                      <span>{r.hint}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="poster-ctrl-group">
                <span className="poster-ctrl-label">Backdrop</span>
                <div className="poster-swatches">
                  {BACKDROPS.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      className={`poster-swatch ${backdrop === b.id ? "on" : ""}`}
                      onClick={() => setBackdrop(b.id)}
                      title={b.label}
                      aria-label={b.label}
                    >
                      <span className="swatch-dot" style={{ background: b.swatch }} />
                      <span className="swatch-name">{b.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="poster-ctrl-group">
                <span className="poster-ctrl-label">Card Surface</span>
                <div className="poster-seg">
                  {(["auto", "light", "dark"] as const).map((m) => (
                    <button key={m} type="button" className={surface === m ? "on" : ""} onClick={() => setSurface(m)}>
                      {m === "auto" ? "Auto" : m === "light" ? "Light" : "Dark"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="poster-ctrl-group">
                <label className="poster-toggle">
                  <input type="checkbox" checked={brand} onChange={(e) => setBrand(e.target.checked)} />
                  <span>Editorial colophon</span>
                </label>
                {brand ? (
                  <input
                    type="text"
                    className="poster-caption-input"
                    placeholder={`Custom note (default: ${dateStr})`}
                    value={caption}
                    maxLength={48}
                    onChange={(e) => setCaption(e.target.value)}
                  />
                ) : null}
              </div>

              {note ? <p className="poster-note">{note}</p> : null}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the unscaled poster DOM node to a crisp Retina PNG Blob using an inlined
 * SVG foreignObject, requiring zero external dependencies and working completely offline.
 */
async function renderNodeToPng(node: HTMLElement, scale = 2): Promise<Blob> {
  const w = Math.ceil(node.offsetWidth);
  const h = Math.ceil(node.offsetHeight);

  const clone = node.cloneNode(true) as HTMLElement;
  inlineComputedStyles(node, clone);
  clone.style.margin = "0";
  clone.style.transform = "none";
  clone.style.width = `${w}px`;
  clone.style.height = `${h}px`;

  // Strip iframes (which foreignObject cannot render) to clean placeholders if present
  for (const frame of clone.querySelectorAll("iframe")) {
    const placeholder = document.createElement("div");
    placeholder.setAttribute(
      "style",
      "width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:12px;color:#747269;background:#f7f7f4;",
    );
    placeholder.textContent = frame.getAttribute("title") || "Interactive preview";
    frame.replaceWith(placeholder);
  }

  // Embed inline SVG/bitmap images as data URLs so foreignObject renders them without tainting the canvas.
  const imgs = [...clone.querySelectorAll("img")];
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src");
      if (!src || src.startsWith("data:")) return;
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        img.setAttribute("src", dataUrl);
      } catch {
        // Ignore cross-origin images
      }
    }),
  );

  const xml = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}"><foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`;
  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);
  const img = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = svgUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Export failed"))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

const EXPORT_PROPS = [
  "display", "position", "inset", "top", "right", "bottom", "left", "z-index",
  "box-sizing", "width", "min-width", "max-width", "height", "min-height", "max-height",
  "margin", "padding", "overflow", "overflow-x", "overflow-y",
  "flex", "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis",
  "align-items", "align-self", "justify-content", "justify-items", "place-items",
  "grid-template-columns", "grid-template-rows", "grid-column", "grid-row", "gap", "row-gap", "column-gap",
  "background", "background-color", "background-image", "background-size", "background-position",
  "color", "opacity", "border", "border-top", "border-right", "border-bottom", "border-left", "border-radius",
  "box-shadow", "outline", "transform", "clip-path", "object-fit", "vertical-align",
  "font-family", "font-size", "font-weight", "font-style", "font-variant-numeric", "line-height",
  "letter-spacing", "text-align", "text-transform", "text-decoration", "white-space", "word-break", "overflow-wrap",
  "list-style", "border-collapse", "border-spacing",
] as const;

const SVG_PROPS = ["display", "width", "height", "color", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-opacity", "opacity", "flex-shrink"] as const;

function inlineComputedStyles(src: Element, dst: Element): void {
  const cs = getComputedStyle(src);
  const isSvg = src.namespaceURI === "http://www.w3.org/2000/svg";
  const target = dst as HTMLElement | SVGElement;
  if (target.style) {
    const props = isSvg ? SVG_PROPS : EXPORT_PROPS;
    let css = "";
    for (const prop of props) {
      const val = cs.getPropertyValue(prop);
      if (val) css += `${prop}:${val};`;
    }
    target.setAttribute("style", css);
  }
  const srcChildren = src.children;
  const dstChildren = dst.children;
  for (let i = 0; i < srcChildren.length && i < dstChildren.length; i++) {
    inlineComputedStyles(srcChildren[i]!, dstChildren[i]!);
  }
}
