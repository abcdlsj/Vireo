/**
 * The renderer itself, in its own file so the parser (marked and DOMPurify,
 * about 25 kB gzipped) is fetched after the first screen instead of with it.
 * Everything that shows markdown goes through `markdown.tsx`.
 */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useRef } from "react";

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? "";
    if (href.startsWith("#")) return; // in-app links such as #thread/…
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const render = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string);

export function MarkdownBody({ text, className, lang }: { text: string; className: string; lang?: string }) {
  const html = useMemo(() => render(text), [text]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const pre of root.querySelectorAll("pre")) {
      if (pre.querySelector(".code-copy")) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "code-copy";
      btn.textContent = "Copy";
      btn.setAttribute("aria-label", "Copy code");
      pre.appendChild(btn);
    }
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as Element | null)?.closest<HTMLButtonElement>(".code-copy");
      if (!btn || !root.contains(btn)) return;
      const code = btn.parentElement?.querySelector("code")?.textContent ?? btn.parentElement?.textContent ?? "";
      if (!code || !navigator.clipboard) return;
      void navigator.clipboard.writeText(code).then(() => {
        btn.textContent = "Copied";
        btn.classList.add("copied");
        window.setTimeout(() => {
          btn.textContent = "Copy";
          btn.classList.remove("copied");
        }, 1600);
      });
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [html]);

  return <div ref={ref} className={className} lang={lang} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * An answer still being written. Only the paragraph in progress is parsed
 * again as text arrives; the finished ones above it are parsed once.
 */
export function StreamingMarkdownBody({ text, className, lang }: { text: string; className: string; lang?: string }) {
  const cut = settledEnd(text);
  const head = text.slice(0, cut);
  const headHtml = useMemo(() => (head ? render(head) : ""), [head]);
  const html = headHtml + render(text.slice(cut));
  return <div className={className} lang={lang} dangerouslySetInnerHTML={{ __html: html }} />;
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
