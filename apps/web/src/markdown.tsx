/**
 * Markdown, as the app shows it: sanitised HTML with links that leave the app
 * in a new tab. The parser is loaded on demand (markdown-body.tsx) and the
 * text shows as plain text until it arrives, so a card is never held back by
 * a syntax highlighter it may not need.
 */
import { lazy, Suspense } from "react";

const Body = lazy(() => import("./markdown-body").then((m) => ({ default: m.MarkdownBody })));
const Streaming = lazy(() => import("./markdown-body").then((m) => ({ default: m.StreamingMarkdownBody })));

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

const mdClass = (className?: string) => `md${className ? ` ${className}` : ""}`;

export function Markdown({ text, className }: { text: string; className?: string }) {
  const cls = mdClass(className);
  const lang = cjkLang(text);
  return (
    <Suspense fallback={<Plain text={text} className={cls} lang={lang} />}>
      <Body text={text} className={cls} lang={lang} />
    </Suspense>
  );
}

/**
 * An answer still being written. The text is there from the first token; it
 * gains its formatting once the parser has loaded.
 */
export function StreamingMarkdown({ text }: { text: string }) {
  const lang = cjkLang(text);
  return (
    <Suspense fallback={<Plain text={text} className="md" lang={lang} />}>
      <Streaming text={text} className="md" lang={lang} />
    </Suspense>
  );
}

/**
 * The same text, unformatted, as the same paragraphs the parser would make:
 * the layout is already the final one, so nothing moves when it lands.
 */
function Plain({ text, className, lang }: { text: string; className: string; lang?: string }) {
  return (
    <div className={className} lang={lang}>
      {text.split(/\n{2,}/).map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}
