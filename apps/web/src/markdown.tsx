import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? "";
    if (href.startsWith("#")) return; // in-app links such as #thread/…
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/**
 * The language a piece of content is mostly written in, when it is Chinese or
 * Japanese. The app's chrome is English, so text the owner and the agent write
 * carries its own lang: browsers then pick Chinese glyphs and line breaking,
 * and the styles can set it the way Chinese is typeset.
 */
export function cjkLang(text: string): "zh-Hans" | "ja" | undefined {
  const han = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  if (han === 0) return undefined;
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  const words = text.match(/[A-Za-z]+/g)?.length ?? 0;
  return han >= words ? "zh-Hans" : undefined;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => render(text), [text]);
  return <div className={`md ${className ?? ""}`} lang={cjkLang(text)} dangerouslySetInnerHTML={{ __html: html }} />;
}

const render = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string);

/**
 * An answer still being written. Only the paragraph in progress is parsed
 * again as text arrives; the finished ones above it are parsed once.
 */
export function StreamingMarkdown({ text }: { text: string }) {
  const cut = settledEnd(text);
  const head = text.slice(0, cut);
  const headHtml = useMemo(() => (head ? render(head) : ""), [head]);
  const html = headHtml + render(text.slice(cut));
  return <div className="md" lang={cjkLang(text)} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Where the last blank line outside a code block is: everything before it is finished. */
function settledEnd(text: string): number {
  let at = text.lastIndexOf("\n\n");
  while (at > 0) {
    const fences = text.slice(0, at).match(/^\s*(```|~~~)/gm)?.length ?? 0;
    if (fences % 2 === 0) return at;
    at = text.lastIndexOf("\n\n", at - 1);
  }
  return 0;
}
