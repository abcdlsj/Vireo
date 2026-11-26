import { useCallback, useEffect, useRef, useState } from "react";
import type { Card } from "@vireo/protocol";
import { CheckIcon, CloseIcon, CopyIcon, DownloadIcon } from "../icons";
import { cardView } from "./registry";
import { resolvedTheme } from "../theme";

type Ratio = "auto" | "xhs" | "x" | "square";
type Backdrop = "botanical" | "alabaster" | "sunset" | "obsidian" | "forest" | "mist";
type CardSurface = "auto" | "light" | "dark";

const RATIOS: { id: Ratio; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Fit card" },
  { id: "xhs", label: "XHS 3:4", hint: "Xiaohongshu" },
  { id: "x", label: "X 16:9", hint: "Twitter / Cover" },
  { id: "square", label: "1:1", hint: "Square" },
];

const BACKDROPS: { id: Backdrop; label: string; swatch: string; dark?: boolean }[] = [
  { id: "botanical", label: "Botanical", swatch: "linear-gradient(135deg, #dcebe0, #eef4ef)" },
  { id: "alabaster", label: "Alabaster", swatch: "linear-gradient(135deg, #f7f4ec, #e8e2d5)" },
  { id: "sunset", label: "Warm Dawn", swatch: "linear-gradient(135deg, #fbe8d8, #f2ddd9)" },
  { id: "mist", label: "Nordic Mist", swatch: "linear-gradient(135deg, #e7eef6, #dde5ef)" },
  { id: "obsidian", label: "Obsidian", swatch: "linear-gradient(135deg, #1f221f, #0d0e0d)", dark: true },
  { id: "forest", label: "Deep Pine", swatch: "linear-gradient(135deg, #1a3b2a, #0b1811)", dark: true },
];

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
 * Turns any Vireo card into a curated, screenshot-ready poster for Xiaohongshu,
 * X, covers, or direct PNG download.
 */
function CardShareModal({ card, onClose }: { card: Card; onClose: () => void }) {
  const [ratio, setRatio] = useState<Ratio>("auto");
  const [backdrop, setBackdrop] = useState<Backdrop>(() => (resolvedTheme() === "dark" ? "obsidian" : "botanical"));
  const [surface, setSurface] = useState<CardSurface>("auto");
  const [brand, setBrand] = useState(true);
  const [cleanStage, setCleanStage] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "copy">("");
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState("");
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

  const effectiveSurface = surface === "auto" ? (BACKDROPS.find((b) => b.id === backdrop)?.dark ? "dark" : "light") : surface;
  const view = cardView(card.kind);
  const isWide = (typeof view.size === "function" ? view.size(card) : view.size) === "l";

  const exportImage = useCallback(
    async (mode: "save" | "copy") => {
      const el = stageRef.current;
      if (!el || busy) return;
      setBusy(mode);
      setNote("");
      try {
        const blob = await renderNodeToPng(el, 2);
        if (mode === "copy" && navigator.clipboard && typeof ClipboardItem !== "undefined") {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          const slug = (card.title || card.kind).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "vireo-card";
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

  const dateStr = new Date(card.updatedAt || Date.now()).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

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
              <span className="poster-head-eyebrow">Poster Studio</span>
              <h2>{card.title}</h2>
            </div>
            <div className="poster-head-actions">
              <button type="button" className="peek-btn" onClick={() => setCleanStage(true)} title="Hide controls for a clean native screenshot">
                Clean stage
              </button>
              <button type="button" className="peek-btn" disabled={busy !== ""} onClick={() => void exportImage("copy")}>
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? "Copied" : busy === "copy" ? "Copying…" : "Copy PNG"}
              </button>
              <button type="button" className="cbtn primary small" disabled={busy !== ""} onClick={() => void exportImage("save")}>
                <DownloadIcon />
                {busy === "save" ? "Saving…" : "Save PNG"}
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
          <div className="poster-stage-wrap">
            <div
              ref={stageRef}
              className={`poster-canvas ratio-${ratio} bg-${backdrop} ${isWide ? "wide-card" : "compact-card"}`}
              data-theme={effectiveSurface}
            >
              <div className="poster-grain" aria-hidden="true" />
              <div className="poster-card-shell">{view.render({ card, expanded: true, refresh: () => undefined })}</div>
              {brand ? (
                <footer className="poster-colophon">
                  <span className="poster-brand">
                    <img src="/icon.svg" alt="" width={16} height={16} />
                    <span>Vireo</span>
                  </span>
                  <span className="poster-meta">{dateStr}</span>
                </footer>
              ) : null}
            </div>
          </div>

          {!cleanStage ? (
            <aside className="poster-controls">
              <div className="poster-ctrl-group">
                <span className="poster-ctrl-label">Format</span>
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
                <span className="poster-ctrl-label">Studio Backdrop</span>
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
                <span className="poster-ctrl-label">Card Theme</span>
                <div className="poster-seg">
                  {(["auto", "light", "dark"] as const).map((m) => (
                    <button key={m} type="button" className={surface === m ? "on" : ""} onClick={() => setSurface(m)}>
                      {m === "auto" ? "Auto" : m === "light" ? "Light" : "Dark"}
                    </button>
                  ))}
                </div>
              </div>

              <label className="poster-toggle">
                <input type="checkbox" checked={brand} onChange={(e) => setBrand(e.target.checked)} />
                <span>Show Vireo editorial signature</span>
              </label>

              {note ? <p className="poster-note">{note}</p> : null}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders a DOM node to a crisp Retina PNG Blob using an inlined SVG foreignObject,
 * requiring zero external dependencies and working completely offline.
 */
async function renderNodeToPng(node: HTMLElement, scale = 2): Promise<Blob> {
  const rect = node.getBoundingClientRect();
  const w = Math.ceil(rect.width);
  const h = Math.ceil(rect.height);

  const clone = node.cloneNode(true) as HTMLElement;
  inlineComputedStyles(node, clone);
  clone.style.margin = "0";
  clone.style.width = `${w}px`;
  clone.style.height = `${h}px`;

  // Embed inline SVG images as data URLs so foreignObject renders them without tainting the canvas.
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
        // Ignore non-fetchable cross-origin images
      }
    }),
  );

  const xml = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}"><foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`;
  const img = new Image();
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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
}

function inlineComputedStyles(src: Element, dst: Element): void {
  const cs = getComputedStyle(src);
  const target = dst as HTMLElement | SVGElement;
  if (target.style) {
    let css = "";
    for (let i = 0; i < cs.length; i++) {
      const prop = cs[i]!;
      css += `${prop}:${cs.getPropertyValue(prop)};`;
    }
    target.setAttribute("style", css);
  }
  const srcChildren = src.children;
  const dstChildren = dst.children;
  for (let i = 0; i < srcChildren.length && i < dstChildren.length; i++) {
    inlineComputedStyles(srcChildren[i]!, dstChildren[i]!);
  }
}
